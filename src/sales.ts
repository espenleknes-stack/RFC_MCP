// Sales and distribution reads for a chat assistant: find a customer, find sales orders, and read one
// order with its prices and logistics. Every table read goes through selectRows, so the sensitive-table
// denylist and the operator's table list apply exactly as they do for RfcReadTable. Nothing here writes.
import { z } from 'zod';
import { PolicyError, SALES_ORDER_READER, assertReadableTable, sapLanguageKey } from './policy.js';
import { classifyError } from './rfc.js';
import { rows, runSession, selectRows, str, type Caller, type ToolContext, type ToolResult } from './tools.js';

// ---------------------------------------------------------------------------------------------------
// Value conversion between what a person types and what SAP stores.

/** Single-quoted Open SQL literal. Quotes are doubled, so a value can never end the literal early. */
export const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** SAP's ALPHA conversion: an all-digit key is stored with leading zeros. */
export function alphaIn(value: string, length: number): string {
  const trimmed = value.trim().toUpperCase();
  return /^\d+$/.test(trimmed) && trimmed.length <= length ? trimmed.padStart(length, '0') : trimmed;
}

/** The reverse, for display: 0000012345 reads as 12345, as it does in the SAP GUI. */
export function alphaOut(value: unknown): string {
  const text = str(value);
  return /^\d+$/.test(text) ? text.replace(/^0+/, '') : text;
}

/** A LIKE pattern: `*` is the wildcard a person types; without one the value is matched anywhere. */
export function likePattern(value: string, anchored = false): string {
  const trimmed = value.trim();
  if (/[*%]/.test(trimmed)) return trimmed.replace(/\*/g, '%');
  return anchored ? `${trimmed}%` : `%${trimmed}%`;
}

const DATE_IN = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const dateInput = z.string().regex(DATE_IN, 'Use YYYY-MM-DD.');
export const sapDate = (value: string): string => value.replace(/-/g, '');

/** SAP dates arrive as YYYYMMDD (or already ISO); an initial date is null. */
export function dateOut(value: unknown): string | null {
  const text = str(value);
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (!match || /^0+$/.test(match.slice(1).join(''))) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Packed numbers arrive as strings, with SAP's trailing minus when written by RFC_READ_TABLE. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = str(value).replace(/\s/g, '');
  if (!text) return null;
  const signed = text.endsWith('-') ? `-${text.slice(0, -1)}` : text;
  const parsed = Number(signed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Drops empty values so a result carries what the order has, not every blank field SAP returns. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== '' && !(Array.isArray(entry) && entry.length === 0))
  ) as Partial<T>;
}

const text = (value: unknown): string | null => str(value) || null;
const flag = (value: unknown): boolean => str(value) === 'X';

/** `KUNNR IN ('a','b')` in chunks, because one selection line holds at most 72 characters. */
function inList(field: string, values: readonly string[]): string {
  return `${field} IN ( ${values.map(literal).join(' , ')} )`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/** Fails before a connection is opened if the operator's table list leaves a table out. */
function requireTables(ctx: ToolContext, tables: readonly string[]): void {
  for (const table of tables) assertReadableTable(ctx.policy, table);
}

/** Reads keyed rows in chunks, so a long key list never makes one over-long selection. */
async function selectByKeys(
  call: Caller,
  ctx: ToolContext,
  table: string,
  fields: readonly string[],
  keyField: string,
  keys: readonly string[],
  extraWhere?: string
): Promise<Array<Record<string, string>>> {
  const found: Array<Record<string, string>> = [];
  for (const part of chunk([...new Set(keys)], 40)) {
    const where = [inList(keyField, part), extraWhere].filter(Boolean).join(' AND ');
    found.push(...(await selectRows(call, ctx.policy, { table, fields, where })));
  }
  return found;
}

/**
 * A lookup that adds context (names, texts, deliveries) but is not the answer itself. If SAP refuses
 * it, the main result is still returned, with a warning that says what is missing and why.
 */
async function optional<T>(ctx: ToolContext, warnings: unknown[], lookup: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PolicyError) warnings.push({ lookup, code: error.code, message: error.message });
    else {
      const cause = classifyError(error, [ctx.policy.connection.passwd]);
      warnings.push({ lookup, blocker: cause.blocker, detail: cause.message });
    }
    return fallback;
  }
}

const atLeastOne = (args: Record<string, unknown>, keys: readonly string[], message: string) => {
  if (!keys.some((key) => typeof args[key] === 'string' && (args[key] as string).trim() !== ''))
    throw new PolicyError('missing_criteria', message);
};

const code = (max: number) => z.string().trim().min(1).max(max);
const limit = z.number().int().min(1).optional();

// ---------------------------------------------------------------------------------------------------
// CustomerSearch

export const customerSearchSchema = z
  .object({
    name: code(35).optional().describe('Part of the customer name, any case. * is a wildcard.'),
    customer: code(10).optional().describe('Customer number, leading zeros optional. * is a wildcard.'),
    city: code(35).optional().describe('Part of the city name, any case.'),
    postalCode: code(10).optional().describe('Postal code or its beginning.'),
    country: code(3).optional().describe('Country key, for example NO, DE, US.'),
    salesOrg: code(4).optional().describe('Only customers set up in this sales organization.'),
    maxRows: limit.describe('Rows to return, default 50.'),
  })
  .strict();

const CUSTOMER_FIELDS = ['KUNNR', 'NAME1', 'NAME2', 'STRAS', 'PSTLZ', 'ORT01', 'REGIO', 'LAND1', 'KTOKD', 'STCEG', 'LOEVM', 'AUFSD', 'SPERR'];

export function customerWhere(args: z.infer<typeof customerSearchSchema>): string {
  const terms: string[] = [];
  if (args.customer) {
    const value = args.customer.trim();
    terms.push(/[*%]/.test(value) ? `KUNNR LIKE ${literal(likePattern(value.toUpperCase(), true))}` : `KUNNR = ${literal(alphaIn(value, 10))}`);
  }
  if (args.name) {
    // MCOD1 is SAP's upper-case search copy of the first 25 characters of NAME1.
    const pattern = likePattern(args.name);
    const upper = pattern.toUpperCase();
    const options = [`NAME1 LIKE ${literal(pattern)}`];
    if (upper !== pattern) options.push(`NAME1 LIKE ${literal(upper)}`);
    if (upper.replace(/%/g, '').length <= 25) options.push(`MCOD1 LIKE ${literal(upper)}`);
    terms.push(`( ${options.join(' OR ')} )`);
  }
  if (args.city) {
    const pattern = likePattern(args.city);
    const upper = pattern.toUpperCase();
    const options = [`ORT01 LIKE ${literal(pattern)}`];
    if (upper !== pattern) options.push(`ORT01 LIKE ${literal(upper)}`);
    if (upper.replace(/%/g, '').length <= 25) options.push(`MCOD3 LIKE ${literal(upper)}`);
    terms.push(`( ${options.join(' OR ')} )`);
  }
  if (args.postalCode) terms.push(`PSTLZ LIKE ${literal(likePattern(args.postalCode.toUpperCase(), true))}`);
  if (args.country) terms.push(`LAND1 = ${literal(args.country.toUpperCase())}`);
  return terms.join(' AND ');
}

export function customerSearch(ctx: ToolContext, args: z.infer<typeof customerSearchSchema>): Promise<ToolResult> {
  return runSession(
    ctx,
    'CustomerSearch',
    () => {
      atLeastOne(args, ['name', 'customer', 'city', 'postalCode'], 'Give at least a name, customer number, city or postal code.');
      requireTables(ctx, args.salesOrg ? ['KNA1', 'KNVV'] : ['KNA1']);
      return { where: customerWhere(args), limit: Math.min(args.maxRows ?? 50, ctx.policy.maxRows) };
    },
    async (call, { where, limit: max }) => {
      let customers = await selectRows(call, ctx.policy, { table: 'KNA1', fields: CUSTOMER_FIELDS, where, maxRows: max });
      const capped = customers.length >= max;
      const salesAreas = new Map<string, Array<Record<string, unknown>>>();
      if (args.salesOrg && customers.length > 0) {
        const areas = await selectByKeys(
          call,
          ctx,
          'KNVV',
          ['KUNNR', 'VKORG', 'VTWEG', 'SPART', 'AUFSD', 'LOEVM'],
          'KUNNR',
          customers.map((row) => row.KUNNR!),
          `VKORG = ${literal(args.salesOrg.toUpperCase())}`
        );
        for (const area of areas)
          salesAreas.set(area.KUNNR!, [
            ...(salesAreas.get(area.KUNNR!) ?? []),
            compact({ salesOrg: area.VKORG, distributionChannel: area.VTWEG, division: area.SPART, orderBlock: text(area.AUFSD), deletionFlag: flag(area.LOEVM) || null }),
          ]);
        customers = customers.filter((row) => salesAreas.has(row.KUNNR!));
      }
      const result = customers
        .map((row) =>
          compact({
            customer: alphaOut(row.KUNNR),
            name: text(row.NAME1),
            name2: text(row.NAME2),
            street: text(row.STRAS),
            postalCode: text(row.PSTLZ),
            city: text(row.ORT01),
            region: text(row.REGIO),
            country: text(row.LAND1),
            vatNumber: text(row.STCEG),
            accountGroup: text(row.KTOKD),
            deletionFlag: flag(row.LOEVM) || null,
            orderBlock: text(row.AUFSD),
            postingBlock: flag(row.SPERR) || null,
            salesAreas: salesAreas.get(row.KUNNR!),
          })
        )
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
      return {
        rowCount: result.length,
        moreRowsPossible: capped,
        ...(capped ? { hint: 'More customers match. Narrow the search or raise maxRows.' } : {}),
        customers: result,
      };
    }
  );
}

// ---------------------------------------------------------------------------------------------------
// SalesOrderSearch

/** VBAK-VBTYP. Orders are the default; the others are reachable on request. */
export const DOCUMENT_CATEGORIES = {
  order: 'C',
  quotation: 'B',
  inquiry: 'A',
  contract: 'G',
  scheduling_agreement: 'E',
  returns: 'H',
  credit_memo_request: 'K',
  debit_memo_request: 'L',
} as const;

export const salesOrderSearchSchema = z
  .object({
    customer: code(10).optional().describe('Sold-to customer number, leading zeros optional.'),
    customerPo: code(35).optional().describe("Part of the customer's purchase order number. * is a wildcard."),
    salesOrder: code(10).optional().describe('Sales document number, or a pattern with *.'),
    material: code(40).optional().describe('Only orders with an item for this material.'),
    salesOrg: code(4).optional(),
    distributionChannel: code(2).optional(),
    division: code(2).optional(),
    orderType: code(4).optional().describe('Sales document type, for example OR or ZOR.'),
    dateFrom: dateInput.optional().describe('Document date from, YYYY-MM-DD.'),
    dateTo: dateInput.optional().describe('Document date to, YYYY-MM-DD.'),
    documentCategory: z
      .enum([...(Object.keys(DOCUMENT_CATEGORIES) as Array<keyof typeof DOCUMENT_CATEGORIES>), 'any'])
      .optional()
      .describe('Default order. Use any for every sales document category.'),
    maxRows: limit.describe('Rows to return, default 50.'),
  })
  .strict();

const ORDER_FIELDS = ['VBELN', 'AUART', 'VBTYP', 'AUDAT', 'ERDAT', 'VKORG', 'VTWEG', 'SPART', 'KUNNR', 'BSTNK', 'NETWR', 'WAERK', 'VDATU', 'LIFSK', 'FAKSK'];

export function salesOrderWhere(args: z.infer<typeof salesOrderSearchSchema>): string {
  const terms: string[] = [];
  const category = args.documentCategory ?? 'order';
  if (category !== 'any') terms.push(`VBTYP = ${literal(DOCUMENT_CATEGORIES[category])}`);
  if (args.salesOrder) {
    const value = args.salesOrder.trim();
    terms.push(/[*%]/.test(value) ? `VBELN LIKE ${literal(likePattern(value, true))}` : `VBELN = ${literal(alphaIn(value, 10))}`);
  }
  if (args.customer) terms.push(`KUNNR = ${literal(alphaIn(args.customer, 10))}`);
  if (args.customerPo) {
    const pattern = likePattern(args.customerPo);
    terms.push(pattern === pattern.toUpperCase() ? `BSTNK LIKE ${literal(pattern)}` : `( BSTNK LIKE ${literal(pattern)} OR BSTNK LIKE ${literal(pattern.toUpperCase())} )`);
  }
  if (args.salesOrg) terms.push(`VKORG = ${literal(args.salesOrg.toUpperCase())}`);
  if (args.distributionChannel) terms.push(`VTWEG = ${literal(args.distributionChannel.toUpperCase())}`);
  if (args.division) terms.push(`SPART = ${literal(args.division.toUpperCase())}`);
  if (args.orderType) terms.push(`AUART = ${literal(args.orderType.toUpperCase())}`);
  if (args.dateFrom) terms.push(`AUDAT >= ${literal(sapDate(args.dateFrom))}`);
  if (args.dateTo) terms.push(`AUDAT <= ${literal(sapDate(args.dateTo))}`);
  return terms.join(' AND ');
}

export function salesOrderSearch(ctx: ToolContext, args: z.infer<typeof salesOrderSearchSchema>): Promise<ToolResult> {
  return runSession(
    ctx,
    'SalesOrderSearch',
    () => {
      atLeastOne(args, ['customer', 'customerPo', 'salesOrder', 'material', 'dateFrom', 'dateTo'], 'Give at least a customer, purchase order number, order number, material or date.');
      requireTables(ctx, ['VBAK', 'KNA1', ...(args.material ? ['VBAP'] : [])]);
      return { where: salesOrderWhere(args), limit: Math.min(args.maxRows ?? 50, ctx.policy.maxRows) };
    },
    async (call, { where, limit: max }) => {
      const warnings: unknown[] = [];
      const ceiling = ctx.policy.maxRows;
      // RFC_READ_TABLE cannot sort. Read only number and date for up to the row ceiling, keep the newest,
      // then read the full rows for those, so "the latest orders" holds whenever fewer than the ceiling match.
      let candidates: Array<Record<string, string>>;
      let ceilingReached: boolean;
      if (args.material) {
        const items = await selectRows(call, ctx.policy, {
          table: 'VBAP',
          fields: ['VBELN', 'POSNR'],
          where: `MATNR = ${literal(alphaIn(args.material, 18))}`,
        });
        const keys = [...new Set(items.map((row) => row.VBELN!))];
        candidates = keys.length ? await selectByKeys(call, ctx, 'VBAK', ['VBELN', 'AUDAT'], 'VBELN', keys, where) : [];
        ceilingReached = items.length >= ceiling;
      } else {
        candidates = await selectRows(call, ctx.policy, { table: 'VBAK', fields: ['VBELN', 'AUDAT'], where, maxRows: ceiling });
        ceilingReached = candidates.length >= ceiling;
      }
      const newest = candidates.sort(newestFirst).slice(0, max);
      const orders = newest.length ? (await selectByKeys(call, ctx, 'VBAK', ORDER_FIELDS, 'VBELN', newest.map((row) => row.VBELN!))).sort(newestFirst) : [];
      const capped = ceilingReached || candidates.length > max;
      const hint = ceilingReached
        ? `More than ${ceiling} orders match, so these may not be the newest. Narrow with dateFrom/dateTo.`
        : candidates.length > max
          ? `${candidates.length} orders match; these are the newest ${max}. Raise maxRows or narrow the search for the rest.`
          : null;
      const names = await optional(
        ctx,
        warnings,
        'customer names',
        async () => new Map((await selectByKeys(call, ctx, 'KNA1', ['KUNNR', 'NAME1', 'ORT01'], 'KUNNR', orders.map((row) => row.KUNNR!))).map((row) => [row.KUNNR!, row])),
        new Map<string, Record<string, string>>()
      );
      return compact({
        rowCount: orders.length,
        matchCount: ceilingReached ? null : candidates.length,
        moreRowsPossible: capped,
        hint,
        warnings,
        orders: orders.map((row) =>
          compact({
            salesOrder: alphaOut(row.VBELN),
            orderType: text(row.AUART),
            category: text(row.VBTYP),
            documentDate: dateOut(row.AUDAT),
            createdOn: dateOut(row.ERDAT),
            salesOrg: text(row.VKORG),
            distributionChannel: text(row.VTWEG),
            division: text(row.SPART),
            soldTo: alphaOut(row.KUNNR),
            soldToName: text(names.get(row.KUNNR!)?.NAME1),
            soldToCity: text(names.get(row.KUNNR!)?.ORT01),
            customerPo: text(row.BSTNK),
            netValue: num(row.NETWR),
            currency: text(row.WAERK),
            requestedDeliveryDate: dateOut(row.VDATU),
            deliveryBlock: text(row.LIFSK),
            billingBlock: text(row.FAKSK),
          })
        ),
      });
    }
  );
}

const newestFirst = (a: Record<string, string>, b: Record<string, string>) => (b.AUDAT ?? '').localeCompare(a.AUDAT ?? '') || (b.VBELN ?? '').localeCompare(a.VBELN ?? '');


// ---------------------------------------------------------------------------------------------------
// SalesOrderDetails

export const salesOrderDetailsSchema = z
  .object({
    salesOrder: code(10).describe('Sales document number, leading zeros optional.'),
    includeStatisticalConditions: z.boolean().optional().describe('Also list statistical and inactive pricing conditions (cost, rebate accruals and the like). Default false.'),
  })
  .strict();

/** The BAPI's views. CREDCARD is deliberately absent: payment-card data never leaves SAP. */
export const ORDER_VIEWS = {
  HEADER: 'X',
  ITEM: 'X',
  SDSCHEDULE: 'X',
  BUSINESS: 'X',
  PARTNER: 'X',
  ADDRESS: 'X',
  STATUS_H: 'X',
  STATUS_I: 'X',
  SDCOND: 'X',
  FLOW: 'X',
} as const;

const PARTNER_ROLES: Readonly<Record<string, string>> = {
  AG: 'sold-to',
  WE: 'ship-to',
  RE: 'bill-to',
  RG: 'payer',
  SP: 'forwarding agent',
  VE: 'sales employee',
  AP: 'contact person',
};

/** English names for VBTYP, used when the DD07T lookup in the logon language is not available. */
const DOCUMENT_CATEGORY_NAMES: Readonly<Record<string, string>> = {
  A: 'Inquiry',
  B: 'Quotation',
  C: 'Order',
  E: 'Scheduling agreement',
  G: 'Contract',
  H: 'Returns',
  I: 'Order w/o charge',
  J: 'Delivery',
  K: 'Credit memo request',
  L: 'Debit memo request',
  M: 'Invoice',
  N: 'Invoice canceled',
  O: 'Credit memo',
  P: 'Debit memo',
  Q: 'WMS transfer order',
  R: 'Goods movement',
  S: 'Credit memo canceled',
  T: 'Returns delivery for order',
  U: 'Pro forma invoice',
  V: 'Purchase order',
  X: 'Handling unit',
  '8': 'Shipment',
  h: 'Cancel goods issue',
  i: 'Goods receipt',
  z: 'Production order',
  '+': 'Accounting document',
};

/** SAP status values mean different things per status field, so each gets its own reading. */
const statusReader =
  (meanings: Readonly<Record<string, string>>) =>
  (value: unknown): string | null => {
    const key = str(value);
    return key ? (meanings[key] ?? key) : null;
  };
const processing = statusReader({ A: 'not yet processed', B: 'partially processed', C: 'completely processed' });
const rejection = statusReader({ A: 'nothing rejected', B: 'partially rejected', C: 'completely rejected' });
const credit = statusReader({ A: 'checked, OK', B: 'checked, not OK', C: 'partially released', D: 'released' });
const completeness = statusReader({ A: 'incomplete', B: 'incomplete', C: 'complete' });

interface TextTable {
  table: string;
  key: string;
  text: string;
  /** The table's language field, filled with the logon language. */
  language?: string;
  where?: string;
}

const TEXTS = {
  conditionTypes: { table: 'T685T', key: 'KSCHL', text: 'VTEXT', language: 'SPRAS', where: "KVEWE = 'A' AND KAPPL = 'V'" },
  categories: { table: 'DD07T', key: 'DOMVALUE_L', text: 'DDTEXT', language: 'DDLANGUAGE', where: "DOMNAME = 'VBTYP' AND AS4LOCAL = 'A'" },
  paymentTerms: { table: 'TVZBT', key: 'ZTERM', text: 'VTEXT', language: 'SPRAS' },
  shippingConditions: { table: 'TVSBT', key: 'VSBED', text: 'VTEXT', language: 'SPRAS' },
  incoterms: { table: 'TINCT', key: 'INCO1', text: 'BEZEI', language: 'SPRAS' },
  routes: { table: 'TVROT', key: 'ROUTE', text: 'BEZEI', language: 'SPRAS' },
  plants: { table: 'T001W', key: 'WERKS', text: 'NAME1' },
  rejectionReasons: { table: 'TVAGT', key: 'ABGRU', text: 'BEZEI', language: 'SPRAS' },
} as const satisfies Record<string, TextTable>;

/**
 * Names for codes, so "0090" reads as its payment terms. Optional context: a text table the operator
 * has not enabled is skipped silently, and an SAP refusal becomes a warning, never a failed answer.
 */
async function lookupTexts(call: Caller, ctx: ToolContext, warnings: unknown[], spec: TextTable, keys: Iterable<unknown>): Promise<Map<string, string>> {
  const wanted = [...new Set([...keys].map(str).filter(Boolean))];
  if (wanted.length === 0) return new Map();
  try {
    assertReadableTable(ctx.policy, spec.table);
  } catch {
    return new Map();
  }
  return optional(
    ctx,
    warnings,
    `${spec.table} texts`,
    async () => {
      const filter = [spec.language ? `${spec.language} = ${literal(sapLanguageKey(ctx.policy.connection.lang))}` : null, spec.where ?? null].filter(Boolean).join(' AND ');
      const found = await selectByKeys(call, ctx, spec.table, [spec.key, spec.text], spec.key, wanted, filter || undefined);
      const names = new Map<string, string>();
      for (const row of found) if (!names.has(row[spec.key]!)) names.set(row[spec.key]!, row[spec.text]!);
      return names;
    },
    new Map<string, string>()
  );
}

const isHeaderRow = (row: Record<string, unknown>) => /^0*$/.test(str(row.ITM_NUMBER));

interface FlowDocument {
  document: string;
  category: string;
  level: number | null;
  createdOn: string | null;
  precededBy: string;
  orderItems: Set<string>;
}

export function salesOrderDetails(ctx: ToolContext, args: z.infer<typeof salesOrderDetailsSchema>): Promise<ToolResult> {
  return runSession(
    ctx,
    'SalesOrderDetails',
    () => {
      const vbeln = alphaIn(args.salesOrder, 10);
      if (!/^[A-Z0-9]{1,10}$/.test(vbeln)) throw new PolicyError('invalid_input', 'A sales document number has at most 10 letters or digits.');
      return { vbeln };
    },
    async (call, { vbeln }) => {
      const warnings: unknown[] = [];
      const result = await call(SALES_ORDER_READER, { I_BAPI_VIEW: ORDER_VIEWS, SALES_DOCUMENTS: [{ VBELN: vbeln }] });
      const header = rows(result.ORDER_HEADERS_OUT)[0];
      if (!header) throw new PolicyError('not_found', `Sales document ${alphaOut(vbeln)} was not found, or this SAP user may not display it.`);

      const items = rows(result.ORDER_ITEMS_OUT);
      const schedules = rows(result.ORDER_SCHEDULES_OUT);
      const business = rows(result.ORDER_BUSINESS_OUT);
      const headerBusiness = business.find(isHeaderRow);
      const partners = rows(result.ORDER_PARTNERS_OUT).filter(isHeaderRow);
      const addresses = new Map(rows(result.ORDER_ADDRESS_OUT).map((row) => [str(row.ADDRESS), row]));
      const headerStatus = rows(result.ORDER_STATUSHEADERS_OUT)[0];
      const itemStatus = new Map(rows(result.ORDER_STATUSITEMS_OUT).map((row) => [str(row.ITM_NUMBER), row]));
      // Subtotal lines carry no condition type; statistical and inactive ones are not part of the price.
      const conditions = rows(result.ORDER_CONDITIONS_OUT).filter(
        (row) => str(row.COND_TYPE) && (args.includeStatisticalConditions || (!flag(row.STAT_CON) && !str(row.CONDISACTI)))
      );
      const currency = text(header.CURRENCY);

      // The flow covers the whole chain (order, delivery, goods movement, invoice), one row per item link.
      const documents = new Map<string, FlowDocument>();
      for (const row of rows(result.ORDER_FLOWS_OUT)) {
        const document = str(row.SUBSSDDOC);
        if (!document) continue;
        const category = str(row.DOCCATEGOR);
        const key = `${category}:${document}`;
        const entry: FlowDocument = documents.get(key) ?? {
          document,
          category,
          level: num(row.LEVELFLOWR),
          createdOn: dateOut(row.CREAT_DATE),
          precededBy: str(row.PRECSDDOC),
          orderItems: new Set<string>(),
        };
        if (str(row.PRECSDDOC) === vbeln && alphaOut(row.PREDITDOC)) entry.orderItems.add(alphaOut(row.PREDITDOC));
        documents.set(key, entry);
      }
      const flow = [...documents.values()].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || String(a.createdOn).localeCompare(String(b.createdOn)));
      const deliveryNumbers = flow.filter((doc) => doc.category === 'J' || doc.category === 'T').map((doc) => doc.document);
      const shipmentNumbers = flow.filter((doc) => doc.category === '8').map((doc) => doc.document);

      const noRows: Array<Record<string, string>> = [];
      const deliveries = deliveryNumbers.length
        ? await optional(
            ctx,
            warnings,
            'deliveries',
            () =>
              selectByKeys(
                call,
                ctx,
                'LIKP',
                ['VBELN', 'LFART', 'LFDAT', 'WADAT', 'WADAT_IST', 'VSTEL', 'ROUTE', 'VSART', 'KUNNR', 'BTGEW', 'NTGEW', 'GEWEI', 'ANZPK', 'BOLNR', 'TRAID', 'LIFEX'],
                'VBELN',
                deliveryNumbers
              ),
            noRows
          )
        : noRows;
      const shipments = shipmentNumbers.length
        ? await optional(
            ctx,
            warnings,
            'shipments',
            () =>
              selectByKeys(
                call,
                ctx,
                'VTTK',
                ['TKNUM', 'SHTYP', 'TDLNR', 'ROUTE', 'VSART', 'STTRG', 'DPTBG', 'DATBG', 'DPTEN', 'DATEN', 'EXTI1', 'EXTI2', 'SIGNI', 'TPBEZ'],
                'TKNUM',
                shipmentNumbers
              ),
            noRows
          )
        : noRows;

      const names = {
        conditionTypes: await lookupTexts(call, ctx, warnings, TEXTS.conditionTypes, conditions.map((row) => row.COND_TYPE)),
        categories: await lookupTexts(call, ctx, warnings, TEXTS.categories, flow.map((doc) => doc.category)),
        paymentTerms: await lookupTexts(call, ctx, warnings, TEXTS.paymentTerms, [headerBusiness?.PMNTTRMS]),
        shippingConditions: await lookupTexts(call, ctx, warnings, TEXTS.shippingConditions, [header.SHIP_COND]),
        incoterms: await lookupTexts(call, ctx, warnings, TEXTS.incoterms, business.map((row) => row.INCOTERMS1)),
        routes: await lookupTexts(call, ctx, warnings, TEXTS.routes, [...items.map((row) => row.ROUTE), ...deliveries.map((row) => row.ROUTE), ...shipments.map((row) => row.ROUTE)]),
        plants: await lookupTexts(call, ctx, warnings, TEXTS.plants, items.map((row) => row.PLANT)),
        rejectionReasons: await lookupTexts(call, ctx, warnings, TEXTS.rejectionReasons, items.map((row) => row.REA_FOR_RE)),
      };
      const named = (map: Map<string, string>, value: unknown) => text(map.get(str(value)));
      const categoryName = (category: string) => text(names.categories.get(category)) ?? DOCUMENT_CATEGORY_NAMES[category] ?? category;

      const pricing = (item: string, itemCurrency: string | null) =>
        conditions
          .filter((row) => str(row.ITM_NUMBER) === item)
          .sort((a, b) => str(a.COND_ST_NO).localeCompare(str(b.COND_ST_NO)) || str(a.COND_COUNT).localeCompare(str(b.COND_COUNT)))
          .map((row) => {
            const percent = str(row.CALCTYPCON) === 'A';
            return compact({
              type: text(row.COND_TYPE),
              name: named(names.conditionTypes, row.COND_TYPE),
              rate: num(row.COND_VALUE),
              rateUnit: percent ? '%' : text(row.CURRENCY),
              per: percent ? null : num(row.COND_P_UNT) || null,
              perUnit: percent ? null : text(row.COND_D_UNT),
              value: num(row.CONDVALUE),
              currency: text(row.SDCURRENCY) ?? itemCurrency ?? currency,
              manual: str(row.CONDORIGIN) === 'C' || null,
              statistical: flag(row.STAT_CON) || null,
              inactive: text(row.CONDISACTI),
            });
          });

      const activeItems = items.filter((item) => !str(item.REA_FOR_RE));
      const tax = Math.round(activeItems.reduce((sum, item) => sum + (num(item.TAX_AMOUNT) ?? 0), 0) * 100) / 100;
      const net = num(header.NET_VAL_HD);

      return compact({
        header: compact({
          salesOrder: alphaOut(header.DOC_NUMBER) || alphaOut(vbeln),
          orderType: text(header.DOC_TYPE),
          category: categoryName(str(header.SD_DOC_CAT)),
          salesOrg: text(header.SALES_ORG),
          distributionChannel: text(header.DISTR_CHAN),
          division: text(header.DIVISION),
          salesOffice: text(header.SALES_OFF),
          salesGroup: text(header.SALES_GRP),
          soldTo: alphaOut(header.SOLD_TO) || null,
          customerPo: text(header.PURCH_NO) ?? text(headerBusiness?.PURCH_NO_C),
          customerPoDate: dateOut(header.PURCH_DATE),
          documentDate: dateOut(header.DOC_DATE),
          createdOn: dateOut(header.REC_DATE),
          createdBy: text(header.CREATED_BY),
          requestedDeliveryDate: dateOut(header.REQ_DATE_H),
          orderReason: text(header.ORD_REASON),
          deliveryBlock: text(header.DLV_BLOCK),
          billingBlock: text(header.BILL_BLOCK),
        }),
        totals: compact({ netValue: net, tax, grossValue: net === null ? null : Math.round((net + tax) * 100) / 100, currency }),
        status: headerStatus
          ? compact({
              overall: processing(headerStatus.PRC_STAT_H),
              delivery: processing(headerStatus.DLV_STAT_H),
              confirmation: processing(headerStatus.CONFIRSTAT),
              goodsMovement: processing(headerStatus.TOTGOODSMV),
              billing: processing(headerStatus.BILLSTATUS) ?? processing(headerStatus.BILLINGSTA),
              rejection: rejection(headerStatus.OVERALLREJ),
              credit: credit(headerStatus.CREDCHECK),
              completeness: completeness(headerStatus.TOTINCOMPL),
            })
          : null,
        terms: compact({
          incoterms: text(headerBusiness?.INCOTERMS1),
          incotermsName: named(names.incoterms, headerBusiness?.INCOTERMS1),
          incotermsPlace: text(headerBusiness?.INCOTERMS2L) ?? text(headerBusiness?.INCOTERMS2),
          paymentTerms: text(headerBusiness?.PMNTTRMS),
          paymentTermsName: named(names.paymentTerms, headerBusiness?.PMNTTRMS),
          shippingConditions: text(header.SHIP_COND),
          shippingConditionsName: named(names.shippingConditions, header.SHIP_COND),
          completeDelivery: flag(header.COMPL_DLV) || null,
          pricingDate: dateOut(headerBusiness?.PRICE_DATE),
          priceList: text(headerBusiness?.PRICE_LIST),
          priceGroup: text(headerBusiness?.PRICE_GRP),
          customerGroup: text(headerBusiness?.CUST_GROUP),
        }),
        partners: partners.map((row) => {
          const address = addresses.get(str(row.ADDRESS));
          const role = str(row.PARTN_ROLE);
          return compact({
            role: PARTNER_ROLES[role] ?? role,
            roleCode: role,
            customer: alphaOut(row.CUSTOMER) || null,
            vendor: alphaOut(row.VENDOR_NO) || null,
            personnelNumber: alphaOut(row.PERSON_NO) || null,
            contactPerson: alphaOut(row.CONTACT) || null,
            name: text(address?.NAME),
            name2: text(address?.NAME_2),
            street: [str(address?.STREET), str(address?.HOUSE_NO_LONG)].filter(Boolean).join(' ') || null,
            postalCode: text(address?.POSTL_CODE),
            city: text(address?.CITY),
            region: text(address?.REGION),
            country: text(address?.COUNTRY) ?? text(row.COUNTRY),
            phone: text(address?.TELEPHONE),
            email: text(address?.E_MAIL),
            transportZone: text(row.TRANSPZONE),
          });
        }),
        items: items.map((item) => {
          const number = str(item.ITM_NUMBER);
          const itemBusiness = business.find((row) => str(row.ITM_NUMBER) === number);
          const state = itemStatus.get(number);
          const itemCurrency = text(item.CURRENCY);
          return compact({
            item: alphaOut(number),
            higherLevelItem: alphaOut(item.HG_LV_ITEM) || null,
            material: alphaOut(item.MATERIAL) || null,
            description: text(item.SHORT_TEXT),
            customerMaterial: text(item.CUST_MAT35) ?? text(item.CUST_MAT22),
            itemCategory: text(item.ITEM_CATEG),
            quantity: num(item.REQ_QTY),
            confirmedQuantity: num(item.CUM_CF_QTY),
            unit: text(item.SALES_UNIT),
            netPrice: num(item.NET_PRICE),
            pricePer: num(item.COND_P_UNT) || null,
            priceUnit: text(item.COND_UNIT),
            netValue: num(item.NET_VALUE),
            tax: num(item.TAX_AMOUNT),
            currency: itemCurrency,
            rejectionReason: text(item.REA_FOR_RE),
            rejectionReasonName: named(names.rejectionReasons, item.REA_FOR_RE),
            billingBlock: text(item.BILL_BLOCK),
            status: state
              ? compact({
                  overall: processing(state.OVRPROCSTA),
                  delivery: processing(state.DLV_STAT_I),
                  confirmation: processing(state.CONFSTATIT),
                  picking: processing(state.PICKINGSTA),
                  goodsMovement: processing(state.GOODSMVSTA),
                  billing: processing(state.BILLSTATIT),
                  rejection: rejection(state.REJSTATIT),
                })
              : null,
            logistics: compact({
              plant: text(item.PLANT),
              plantName: named(names.plants, item.PLANT),
              storageLocation: text(item.STGE_LOC),
              shippingPoint: text(item.SHIP_POINT),
              route: text(item.ROUTE),
              routeName: named(names.routes, item.ROUTE),
              deliveryPriority: text(item.DLV_PRIO),
              partialDelivery: text(item.PART_DLV),
              deliveryGroup: alphaOut(item.DLV_GROUP) || null,
              grossWeight: num(item.GROSS_WEIG),
              netWeight: num(item.NET_WEIGHT),
              weightUnit: text(item.UNIT_OF_WT),
              volume: num(item.VOLUME) || null,
              volumeUnit: text(item.VOLUMEUNIT),
              incoterms: itemBusiness && str(itemBusiness.INCOTERMS1) !== str(headerBusiness?.INCOTERMS1) ? text(itemBusiness.INCOTERMS1) : null,
            }),
            scheduleLines: schedules
              .filter((row) => str(row.ITM_NUMBER) === number)
              .map((row) =>
                compact({
                  line: alphaOut(row.SCHED_LINE),
                  deliveryDate: dateOut(row.REQ_DATE),
                  orderedQuantity: num(row.REQ_QTY),
                  confirmedQuantity: num(row.CONFIR_QTY),
                  unit: text(row.SALES_UNIT),
                  materialAvailability: dateOut(row.MS_DATE),
                  transportPlanning: dateOut(row.TP_DATE),
                  loading: dateOut(row.LOAD_DATE),
                  goodsIssue: dateOut(row.GI_DATE),
                  deliveryBlock: text(row.REQ_DLV_BL),
                })
              ),
            pricing: pricing(number, itemCurrency),
          });
        }),
        headerPricing: pricing('000000', currency),
        deliveries: deliveries.map((row) =>
          compact({
            delivery: alphaOut(row.VBELN),
            type: text(row.LFART),
            deliveryDate: dateOut(row.LFDAT),
            plannedGoodsIssue: dateOut(row.WADAT),
            actualGoodsIssue: dateOut(row.WADAT_IST),
            goodsIssued: dateOut(row.WADAT_IST) !== null,
            shippingPoint: text(row.VSTEL),
            route: text(row.ROUTE),
            routeName: named(names.routes, row.ROUTE),
            shippingType: text(row.VSART),
            shipTo: alphaOut(row.KUNNR) || null,
            grossWeight: num(row.BTGEW),
            netWeight: num(row.NTGEW),
            weightUnit: text(row.GEWEI),
            packages: num(row.ANZPK) || null,
            billOfLading: text(row.BOLNR),
            meansOfTransport: text(row.TRAID),
            externalId: text(row.LIFEX),
          })
        ),
        shipments: shipments.map((row) =>
          compact({
            shipment: alphaOut(row.TKNUM),
            type: text(row.SHTYP),
            carrier: alphaOut(row.TDLNR) || null,
            route: text(row.ROUTE),
            routeName: named(names.routes, row.ROUTE),
            shippingType: text(row.VSART),
            status: text(row.STTRG),
            plannedStart: dateOut(row.DPTBG),
            actualStart: dateOut(row.DATBG),
            plannedEnd: dateOut(row.DPTEN),
            actualEnd: dateOut(row.DATEN),
            externalId: text(row.EXTI1),
            externalId2: text(row.EXTI2),
            containerId: text(row.SIGNI),
            description: text(row.TPBEZ),
          })
        ),
        documentFlow: flow.map((doc) =>
          compact({
            document: alphaOut(doc.document),
            category: categoryName(doc.category),
            createdOn: doc.createdOn,
            precededBy: alphaOut(doc.precededBy),
            orderItems: [...doc.orderItems],
            level: doc.level,
          })
        ),
        warnings,
      });
    }
  );
}
