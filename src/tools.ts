import { z } from 'zod';
import {
  FIXED_READ_FUNCTIONS,
  INTERFACE_READER,
  PolicyError,
  TABLE_READER,
  assertExtendedFunction,
  assertFixedFunction,
  assertReadableTable,
  isDeniedFunction,
  normalizeName,
  type Policy,
} from './policy.js';
import { classifyError, type Connect, type RfcParameters } from './rfc.js';

export interface ToolResult {
  [key: string]: unknown;
  isError: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

export interface Logger {
  (event: Record<string, unknown>): void;
}

export interface ToolContext {
  policy: Policy;
  connect: Connect;
  log: Logger;
}

const MAX_RESULT_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 60 * 1024;
const WHERE_LINE = 72;

const parameters = z.record(z.string().max(30), z.unknown()).default({});
export const describeSchema = z.object({ function: z.string().max(30) }).strict();
export const callSchema = z.object({ function: z.string().max(30), parameters }).strict();
export const readTableSchema = z
  .object({
    table: z.string().max(30),
    fields: z.array(z.string().max(30)).min(1).max(30),
    where: z.string().max(1000).optional(),
    maxRows: z.number().int().min(1).optional(),
    skipRows: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

function ok(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES)
    return refusal('result_too_large', 'The result exceeds 512 KB. Ask for fewer rows, fewer fields or a narrower selection.', true);
  return { isError: false, content: [{ type: 'text', text }] };
}

function refusal(code: string, message: string, dispatched: boolean, extra: Record<string, unknown> = {}): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra }, dispatched }) }] };
}

/**
 * Runs one function module in its own session. A policy refusal never opens a connection; an SAP
 * failure is reported with its cause and is never retried, because delivery may be uncertain.
 */
async function run(
  ctx: ToolContext,
  tool: string,
  prepare: () => { functionName: string; parameters: RfcParameters },
  shape: (result: Record<string, unknown>) => unknown
): Promise<ToolResult> {
  let prepared: { functionName: string; parameters: RfcParameters };
  try {
    prepared = prepare();
    if (Buffer.byteLength(JSON.stringify(prepared.parameters)) > MAX_INPUT_BYTES)
      throw new PolicyError('input_too_large', 'Parameters exceed 60 KB.');
  } catch (error) {
    if (!(error instanceof PolicyError)) throw error;
    ctx.log({ tool, outcome: 'refused', code: error.code });
    return refusal(error.code, `${error.message} Nothing was sent to SAP.`, false);
  }
  const { functionName } = prepared;
  const started = Date.now();
  const secrets = [ctx.policy.connection.passwd];
  let session;
  try {
    session = await ctx.connect();
  } catch (error) {
    const cause = classifyError(error, secrets);
    ctx.log({ tool, functionName, outcome: 'connect_failed', blocker: cause.blocker, ms: Date.now() - started });
    return refusal('rfc_connect_failed', 'Could not log on to the SAP system over RFC.', false, { blocker: cause.blocker, key: cause.key, detail: cause.message });
  }
  try {
    const result = await session.call(functionName, prepared.parameters);
    ctx.log({ tool, functionName, outcome: 'ok', ms: Date.now() - started });
    return ok(shape(result));
  } catch (error) {
    if (error instanceof PolicyError) return refusal(error.code, error.message, true);
    const cause = classifyError(error, secrets);
    ctx.log({ tool, functionName, outcome: 'failed', blocker: cause.blocker, ms: Date.now() - started });
    return refusal('rfc_call_failed', 'SAP did not complete the call. Do not assume it had no effect.', true, { blocker: cause.blocker, key: cause.key, detail: cause.message });
  } finally {
    try {
      await session.close();
    } catch {
      ctx.log({ tool, functionName, outcome: 'close_failed' });
    }
  }
}

const DIRECTIONS: Readonly<Record<string, string>> = { I: 'import', E: 'export', C: 'changing', T: 'tables', X: 'exception' };
const rows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object') : [];
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value));

export function describeFunction(ctx: ToolContext, args: z.infer<typeof describeSchema>): Promise<ToolResult> {
  let name = '';
  return run(
    ctx,
    'RfcDescribeFunction',
    () => {
      name = normalizeName(args.function, 'Function module');
      return { functionName: INTERFACE_READER, parameters: { FUNCNAME: name, LANGUAGE: ctx.policy.connection.lang.slice(0, 2) } };
    },
    (result) => ({
      function: name,
      callableWith:
        name in FIXED_READ_FUNCTIONS && !isDeniedFunction(name)
          ? 'RfcCall'
          : ctx.policy.extendedFunctions.has(name)
            ? 'RfcCallExtended'
            : null,
      parameters: rows(result.PARAMS).map((row) => ({
        name: str(row.PARAMETER),
        direction: DIRECTIONS[str(row.PARAMCLASS)] ?? str(row.PARAMCLASS),
        type: [str(row.TABNAME), str(row.FIELDNAME)].filter(Boolean).join('-') || str(row.EXID),
        optional: str(row.OPTIONAL) === 'X',
        default: str(row.DEFAULT) || undefined,
        text: str(row.PARAMTEXT) || undefined,
      })),
    })
  );
}

/**
 * RFC_READ_TABLE takes the selection as 72-character lines that it joins back together, so a line
 * break inside a quoted literal would change the value. Lines break only on spaces outside quotes.
 */
export function splitWhere(where: string): Array<{ TEXT: string }> {
  if (/[\u0000-\u001f\u007f]/.test(where)) throw new PolicyError('invalid_where', 'The selection contains control characters.');
  const tokens: string[] = [];
  let token = '';
  let quoted = false;
  for (const char of where) {
    if (char === "'") quoted = !quoted;
    if (char === ' ' && !quoted) {
      if (token) tokens.push(token);
      token = '';
    } else token += char;
  }
  if (quoted) throw new PolicyError('invalid_where', 'The selection has an unterminated quoted value.');
  if (token) tokens.push(token);
  const lines: string[] = [];
  for (const part of tokens) {
    if (part.length > WHERE_LINE) throw new PolicyError('invalid_where', `One selection term is longer than ${WHERE_LINE} characters.`);
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + part.length <= WHERE_LINE) lines[lines.length - 1] = `${last} ${part}`;
    else lines.push(part);
  }
  return lines.map((TEXT) => ({ TEXT }));
}

export function readTable(ctx: ToolContext, args: z.infer<typeof readTableSchema>): Promise<ToolResult> {
  let table = '';
  let limit = 0;
  return run(
    ctx,
    'RfcReadTable',
    () => {
      table = assertReadableTable(ctx.policy, args.table);
      const fields = [...new Set(args.fields.map((field) => normalizeName(field, 'Field')))];
      limit = Math.min(args.maxRows ?? 100, ctx.policy.maxRows);
      return {
        functionName: TABLE_READER,
        parameters: {
          QUERY_TABLE: table,
          ROWCOUNT: limit,
          ROWSKIPS: args.skipRows ?? 0,
          FIELDS: fields.map((FIELDNAME) => ({ FIELDNAME })),
          OPTIONS: args.where ? splitWhere(args.where) : [],
        },
      };
    },
    (result) => {
      // Fixed-width slicing by the returned offsets: a delimiter would be ambiguous inside the data.
      const layout = rows(result.FIELDS).map((field) => ({
        name: str(field.FIELDNAME),
        offset: Number(field.OFFSET),
        length: Number(field.LENGTH),
      }));
      if (layout.some((field) => !field.name || !Number.isInteger(field.offset) || !Number.isInteger(field.length)))
        throw new PolicyError('unreadable_result', 'SAP returned a field layout this server cannot interpret.');
      const data = rows(result.DATA).map((row) => {
        const line = typeof row.WA === 'string' ? row.WA : '';
        return Object.fromEntries(layout.map((field) => [field.name, line.slice(field.offset, field.offset + field.length).trimEnd()]));
      });
      return { table, fields: layout.map((field) => field.name), rowCount: data.length, moreRowsPossible: data.length >= limit, rows: data };
    }
  );
}

export function callFixed(ctx: ToolContext, args: z.infer<typeof callSchema>): Promise<ToolResult> {
  let name = '';
  return run(
    ctx,
    'RfcCall',
    () => ({ functionName: (name = assertFixedFunction(args.function)), parameters: args.parameters }),
    (result) => ({ function: name, result })
  );
}

export function callExtended(ctx: ToolContext, args: z.infer<typeof callSchema>): Promise<ToolResult> {
  let name = '';
  return run(
    ctx,
    'RfcCallExtended',
    () => ({ functionName: (name = assertExtendedFunction(ctx.policy, args.function)), parameters: args.parameters }),
    (result) => ({ function: name, committed: false, result })
  );
}
