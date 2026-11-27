import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../src/policy.js';
import { classifyError, type RfcParameters } from '../src/rfc.js';
import { buildServer } from '../src/server.js';
import { splitWhere } from '../src/tools.js';
import { env } from './env.js';

type Reply = Record<string, unknown> | Error;

/** A scripted SAP: records every session and call so a test can assert nothing was sent. */
function harness(extra: Record<string, string> = {}, replies: Record<string, Reply> = {}, connectError?: Error) {
  const calls: Array<{ functionName: string; parameters: RfcParameters }> = [];
  const events: Array<Record<string, unknown>> = [];
  const state = { opened: 0, closed: 0 };
  const policy = loadPolicy({ ...env, ...extra });
  const server = buildServer({
    policy,
    log: (event) => events.push(event),
    connect: async () => {
      if (connectError) throw connectError;
      state.opened += 1;
      return {
        call: async (functionName, parameters) => {
          calls.push({ functionName, parameters });
          const reply = replies[functionName] ?? {};
          if (reply instanceof Error) throw reply;
          return reply;
        },
        close: async () => {
          state.closed += 1;
        },
      };
    },
  });
  const client = new Client({ name: 'test', version: '0' });
  const ready = (async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  })();
  const call = async (name: string, args: Record<string, unknown>) => {
    await ready;
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text) };
  };
  const tools = async () => {
    await ready;
    return (await client.listTools()).tools.map((tool) => tool.name);
  };
  return { call, tools, calls, events, state };
}
const sapError = (key: string, message: string) => Object.assign(new Error(message), { key });

describe('tool surface', () => {
  it('advertises the three read tools, and the extended tool only when the operator enabled something', async () => {
    expect(await harness().tools()).toEqual(['RfcDescribeFunction', 'RfcReadTable', 'RfcCall']);
    expect(await harness({ RFC_MCP_EXTENDED_FUNCTIONS: 'BAPI_MATERIAL_GET_DETAIL' }).tools()).toContain('RfcCallExtended');
  });
});

describe('RfcCall', () => {
  it('calls a fixed read function module in its own session and closes it', async () => {
    const sap = harness({}, { RFC_SYSTEM_INFO: { RFCSI_EXPORT: { RFCSYSID: 'ECC' } } });
    const result = await sap.call('RfcCall', { function: 'rfc_system_info' });
    expect(result).toEqual({ isError: false, body: { function: 'RFC_SYSTEM_INFO', result: { RFCSI_EXPORT: { RFCSYSID: 'ECC' } } } });
    expect(sap.calls).toEqual([{ functionName: 'RFC_SYSTEM_INFO', parameters: {} }]);
    expect(sap.state).toEqual({ opened: 1, closed: 1 });
  });

  it('refuses anything outside the fixed set before opening a connection', async () => {
    const sap = harness({ RFC_MCP_EXTENDED_FUNCTIONS: 'BAPI_MATERIAL_GET_DETAIL' });
    for (const name of ['BAPI_MATERIAL_GET_DETAIL', 'RFC_READ_TABLE', 'RFC_ABAP_INSTALL_AND_RUN', 'BAD NAME']) {
      const result = await sap.call('RfcCall', { function: name });
      expect(result.isError).toBe(true);
      expect(result.body.dispatched).toBe(false);
    }
    expect(sap.state.opened).toBe(0);
  });

  it('reports why SAP refused, without the password, and still closes the session', async () => {
    const sap = harness({}, { RFC_SYSTEM_INFO: sapError('RFC_NO_AUTHORITY', 'No RFC authorization for user RFC_READ (s3cret-value)') });
    const { body } = await sap.call('RfcCall', { function: 'RFC_SYSTEM_INFO' });
    expect(body).toMatchObject({ dispatched: true, error: { code: 'rfc_call_failed', blocker: 'rfc_auth', key: 'RFC_NO_AUTHORITY' } });
    expect(JSON.stringify([body, sap.events])).not.toContain('s3cret-value');
    expect(sap.state.closed).toBe(1);
  });

  it('reports a failed logon as not dispatched', async () => {
    const sap = harness({}, {}, sapError('RFC_LOGON_FAILURE', 'Name or password is incorrect'));
    const { body } = await sap.call('RfcCall', { function: 'RFC_SYSTEM_INFO' });
    expect(body).toMatchObject({ dispatched: false, error: { code: 'rfc_connect_failed', blocker: 'logon', message: 'Could not log on to the SAP system over RFC.' } });
  });

  it('distinguishes an unreachable gateway from a refused logon', async () => {
    const sap = harness({}, {}, sapError('NI_CONNECT_FAILED', 'failed to connect NI socket'));
    expect((await sap.call('RfcCall', { function: 'RFC_SYSTEM_INFO' })).body.error).toMatchObject({ blocker: 'unreachable', detail: 'failed to connect NI socket | NI_CONNECT_FAILED' });
  });

  it('never logs parameters or results', async () => {
    const sap = harness({}, { RPY_PROGRAM_READ: { SOURCE: [{ LINE: 'SECRET-SOURCE-LINE' }] } });
    await sap.call('RfcCall', { function: 'RPY_PROGRAM_READ', parameters: { PROGRAM_NAME: 'ZPRIVATE_NAME' } });
    const logged = JSON.stringify(sap.events);
    expect(logged).toContain('RPY_PROGRAM_READ');
    expect(logged).not.toContain('ZPRIVATE_NAME');
    expect(logged).not.toContain('SECRET-SOURCE-LINE');
  });
});

describe('RfcCallExtended', () => {
  it('calls only operator-enabled function modules and never commits', async () => {
    const sap = harness({ RFC_MCP_EXTENDED_FUNCTIONS: 'BAPI_MATERIAL_GET_DETAIL' }, { BAPI_MATERIAL_GET_DETAIL: { RETURN: { TYPE: 'S' } } });
    const allowed = await sap.call('RfcCallExtended', { function: 'BAPI_MATERIAL_GET_DETAIL', parameters: { MATERIAL: '100-100' } });
    expect(allowed.body).toEqual({ function: 'BAPI_MATERIAL_GET_DETAIL', committed: false, result: { RETURN: { TYPE: 'S' } } });
    const refused = await sap.call('RfcCallExtended', { function: 'BAPI_SALESORDER_CREATEFROMDAT2' });
    expect(refused.body).toMatchObject({ dispatched: false, error: { code: 'function_not_allowed' } });
    expect(sap.calls.map((call) => call.functionName)).toEqual(['BAPI_MATERIAL_GET_DETAIL']);
  });
});

describe('RfcReadTable', () => {
  const reply = {
    FIELDS: [
      { FIELDNAME: 'MATNR', OFFSET: '000000', LENGTH: '000018' },
      { FIELDNAME: 'MTART', OFFSET: '000018', LENGTH: '000004' },
    ],
    DATA: [{ WA: '100-100           FERT' }, { WA: 'A|B               HA' }],
  };

  it('caps rows, sends the selection, and slices rows by the returned offsets', async () => {
    const sap = harness({ RFC_MCP_MAX_ROWS: '2' }, { RFC_READ_TABLE: reply });
    const { body } = await sap.call('RfcReadTable', { table: 'mara', fields: ['matnr', 'MTART', 'matnr'], where: "MTART = 'FERT'", maxRows: 500, skipRows: 4 });
    expect(sap.calls[0]).toEqual({
      functionName: 'RFC_READ_TABLE',
      parameters: { QUERY_TABLE: 'MARA', ROWCOUNT: 2, ROWSKIPS: 4, FIELDS: [{ FIELDNAME: 'MATNR' }, { FIELDNAME: 'MTART' }], OPTIONS: [{ TEXT: "MTART = 'FERT'" }] },
    });
    expect(body).toEqual({
      table: 'MARA',
      fields: ['MATNR', 'MTART'],
      rowCount: 2,
      moreRowsPossible: true,
      rows: [
        { MATNR: '100-100', MTART: 'FERT' },
        { MATNR: 'A|B', MTART: 'HA' },
      ],
    });
  });

  it('never reads a sensitive table, whatever the SAP user may be authorized for', async () => {
    const sap = harness({}, { RFC_READ_TABLE: reply });
    for (const table of ['PA0008', 'USR02', 'PCL2', 'RFCDES']) {
      const { body } = await sap.call('RfcReadTable', { table, fields: ['MANDT'] });
      expect(body).toMatchObject({ dispatched: false, error: { code: 'sensitive_table' } });
    }
    expect(sap.state.opened).toBe(0);
  });

  it('honours the operator table list', async () => {
    const sap = harness({ RFC_MCP_TABLES: 'T001' }, { RFC_READ_TABLE: reply });
    expect((await sap.call('RfcReadTable', { table: 'MARA', fields: ['MATNR'] })).body.error.code).toBe('table_not_allowed');
  });

  it('explains the 512-byte row limit and table authorization refusals', async () => {
    const wide = harness({}, { RFC_READ_TABLE: sapError('DATA_BUFFER_EXCEEDED', 'DATA_BUFFER_EXCEEDED') });
    expect((await wide.call('RfcReadTable', { table: 'MARA', fields: ['MATNR'] })).body.error.blocker).toBe('row_512');
    const denied = harness({}, { RFC_READ_TABLE: sapError('NOT_AUTHORIZED', 'NOT_AUTHORIZED') });
    expect((await denied.call('RfcReadTable', { table: 'MARA', fields: ['MATNR'] })).body.error.blocker).toBe('table_auth');
  });

  it('refuses a result it cannot lay out rather than guessing', async () => {
    const sap = harness({}, { RFC_READ_TABLE: { FIELDS: [{ FIELDNAME: 'MATNR', OFFSET: 'x', LENGTH: '18' }], DATA: [{ WA: 'abc' }] } });
    expect((await sap.call('RfcReadTable', { table: 'MARA', fields: ['MATNR'] })).body.error.code).toBe('unreadable_result');
  });
});

describe('selection lines', () => {
  it('breaks only on spaces outside quoted values and keeps lines within 72 characters', () => {
    const where = `MAKTX = 'a value with several spaces that must stay whole' AND SPRAS = 'E' AND MATNR LIKE '1%' AND MTART = 'FERT'`;
    const lines = splitWhere(where).map((line) => line.TEXT);
    expect(lines.every((line) => line.length <= 72)).toBe(true);
    expect(lines.join(' ')).toBe(where);
    expect(lines.some((line) => line.includes("'a value with several spaces that must stay whole'"))).toBe(true);
  });

  it('refuses unterminated quotes, control characters and over-long terms', () => {
    expect(() => splitWhere("MTART = 'FERT")).toThrow(/unterminated/);
    expect(() => splitWhere("MTART = 'A'\nOR 1 = 1")).toThrow(/control/);
    expect(() => splitWhere(`MAKTX = '${'x'.repeat(80)}'`)).toThrow(/longer than 72/);
  });
});

describe('RfcDescribeFunction', () => {
  it('maps the interface and says which tool can call it', async () => {
    const sap = harness(
      { RFC_MCP_EXTENDED_FUNCTIONS: 'BAPI_MATERIAL_GET_DETAIL' },
      {
        RFC_GET_FUNCTION_INTERFACE: {
          PARAMS: [
            { PARAMCLASS: 'I', PARAMETER: 'MATERIAL', TABNAME: 'BAPIMATDET', FIELDNAME: 'MATERIAL', OPTIONAL: '', PARAMTEXT: 'Material number' },
            { PARAMCLASS: 'T', PARAMETER: 'RETURN', TABNAME: 'BAPIRET2', FIELDNAME: '', OPTIONAL: 'X' },
          ],
        },
      }
    );
    const { body } = await sap.call('RfcDescribeFunction', { function: 'bapi_material_get_detail' });
    expect(sap.calls[0]).toEqual({ functionName: 'RFC_GET_FUNCTION_INTERFACE', parameters: { FUNCNAME: 'BAPI_MATERIAL_GET_DETAIL', LANGUAGE: 'EN' } });
    expect(body).toEqual({
      function: 'BAPI_MATERIAL_GET_DETAIL',
      callableWith: 'RfcCallExtended',
      parameters: [
        { name: 'MATERIAL', direction: 'import', type: 'BAPIMATDET-MATERIAL', optional: false, text: 'Material number' },
        { name: 'RETURN', direction: 'tables', type: 'BAPIRET2', optional: true },
      ],
    });
    expect((await sap.call('RfcDescribeFunction', { function: 'RFC_SYSTEM_INFO' })).body.callableWith).toBe('RfcCall');
    expect((await sap.call('RfcDescribeFunction', { function: 'BAPI_USER_CREATE1' })).body.callableWith).toBeNull();
  });
});

describe('error classification', () => {
  it('separates the causes an operator acts on differently', () => {
    expect(classifyError(sapError('FU_NOT_FOUND', 'FU_NOT_FOUND')).blocker).toBe('absent');
    expect(classifyError(new Error('Function module blocked by the UCON runtime')).blocker).toBe('ucon');
    expect(classifyError(new Error('connection rejected by gateway sec_info')).blocker).toBe('gateway_acl');
    expect(classifyError(new Error('socket hang up')).blocker).toBe('other');
    expect(classifyError(new Error('x'.repeat(900))).message).toHaveLength(300);
  });
});
