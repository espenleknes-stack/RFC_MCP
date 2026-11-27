import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../src/policy.js';
import type { RfcParameters } from '../src/rfc.js';
import { ORDER_VIEWS, alphaIn, alphaOut, customerWhere, dateOut, likePattern, num } from '../src/sales.js';
import { buildServer } from '../src/server.js';
import { splitWhere } from '../src/tools.js';
import { env } from './env.js';

type Row = Record<string, string>;
const WIDTH = 40;

/**
 * A scripted SAP for the sales tools. RFC_READ_TABLE serves rows from per-table datasets, projected to
 * the requested fields in fixed-width form, and honours a `FIELD IN ( ... )` key list so keyed lookups
 * behave. Other selection terms are recorded, not evaluated, so a test asserts what was asked.
 */
function sap(options: { extra?: Record<string, string>; tables?: Record<string, Row[] | Error>; functions?: Record<string, Record<string, unknown> | Error> } = {}) {
  const calls: Array<{ functionName: string; parameters: RfcParameters }> = [];
  const state = { opened: 0, closed: 0 };
  const readTable = (parameters: RfcParameters) => {
    const table = String(parameters.QUERY_TABLE);
    const dataset = options.tables?.[table] ?? [];
    if (dataset instanceof Error) throw dataset;
    const fields = (parameters.FIELDS as Array<{ FIELDNAME: string }>).map((field) => field.FIELDNAME);
    const where = (parameters.OPTIONS as Array<{ TEXT: string }>).map((line) => line.TEXT).join(' ');
    const keyed = /(\w+) IN \( (.*?) \)/.exec(where);
    const keys = keyed ? new Set([...keyed[2]!.matchAll(/'((?:[^']|'')*)'/g)].map((match) => match[1]!.replace(/''/g, "'"))) : null;
    const found = dataset.filter((row) => !keyed || keys!.has(row[keyed[1]!] ?? '')).slice(0, Number(parameters.ROWCOUNT));
    return {
      FIELDS: fields.map((FIELDNAME, index) => ({ FIELDNAME, OFFSET: String(index * WIDTH), LENGTH: String(WIDTH) })),
      DATA: found.map((row) => ({ WA: fields.map((field) => (row[field] ?? '').padEnd(WIDTH)).join('') })),
    };
  };
  const server = buildServer({
    policy: loadPolicy({ ...env, ...options.extra }),
    log: () => undefined,
    connect: async () => {
      state.opened += 1;
      return {
        call: async (functionName, parameters) => {
          calls.push({ functionName, parameters });
          if (functionName === 'RFC_READ_TABLE') return readTable(parameters);
          const reply = options.functions?.[functionName] ?? {};
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
  const reads = () =>
    calls
      .filter((entry) => entry.functionName === 'RFC_READ_TABLE')
      .map((entry) => ({
        table: entry.parameters.QUERY_TABLE,
        fields: (entry.parameters.FIELDS as Array<{ FIELDNAME: string }>).map((field) => field.FIELDNAME),
        where: (entry.parameters.OPTIONS as Array<{ TEXT: string }>).map((line) => line.TEXT).join(' '),
      }));
  return { call, calls, reads, state };
}

describe('value conversion', () => {
  it('adds and removes the leading zeros SAP stores on all-digit keys', () => {
    expect(alphaIn('100001', 10)).toBe('0000100001');
    expect(alphaIn(' ab12 ', 10)).toBe('AB12');
    expect(alphaOut('0005000123')).toBe('5000123');
    expect(alphaOut('000000')).toBe('');
    expect(alphaOut('CHAIR100A')).toBe('CHAIR100A');
  });

  it("reads SAP numbers and dates, including RFC_READ_TABLE's trailing minus", () => {
    expect(num('1234.50-')).toBe(-1234.5);
    expect(num(' 965.250000000 ')).toBe(965.25);
    expect(num('')).toBeNull();
    expect(dateOut('20250417')).toBe('2025-04-17');
    expect(dateOut('00000000')).toBeNull();
    expect(dateOut('')).toBeNull();
  });

  it('turns typed wildcards into LIKE patterns', () => {
    expect(likePattern('acme')).toBe('%acme%');
    expect(likePattern('ac*me')).toBe('ac%me');
    expect(likePattern('45', true)).toBe('45%');
  });
});

describe('CustomerSearch', () => {
  it('matches the name in any case, doubles quotes, and keeps every selection line within 72 characters', () => {
    const where = customerWhere({ name: "O'Brien Møbler", country: 'no' });
    expect(where).toContain("NAME1 LIKE '%O''Brien Møbler%'");
    expect(where).toContain("MCOD1 LIKE '%O''BRIEN MØBLER%'");
    expect(where).toContain("LAND1 = 'NO'");
    const lines = splitWhere(where).map((line) => line.TEXT);
    expect(lines.every((line) => line.length <= 72)).toBe(true);
    expect(lines.join(' ')).toBe(where);
  });

  it('refuses a search without a selective criterion before logging on', async () => {
    const system = sap();
    const { body } = await system.call('CustomerSearch', { country: 'NO' });
    expect(body).toMatchObject({ dispatched: false, error: { code: 'missing_criteria' } });
    expect(system.state.opened).toBe(0);
  });

  it('keeps only customers set up in the requested sales organization', async () => {
    const system = sap({
      tables: {
        KNA1: [
          { KUNNR: '0000100002', NAME1: 'Fjordheim Møbler Alna', ORT01: 'Oslo', LAND1: 'NO' },
          { KUNNR: '0000100003', NAME1: 'Fjordheim Møbler Skøyen', ORT01: 'OSLO', LAND1: 'NO' },
        ],
        KNVV: [{ KUNNR: '0000100002', VKORG: '2000', VTWEG: '01', SPART: '01' }],
      },
    });
    const { body } = await system.call('CustomerSearch', { name: 'fjordheim', salesOrg: '2000' });
    expect(body.customers).toEqual([
      { customer: '100002', name: 'Fjordheim Møbler Alna', city: 'Oslo', country: 'NO', salesAreas: [{ salesOrg: '2000', distributionChannel: '01', division: '01' }] },
    ]);
    expect(system.reads()[1]).toMatchObject({ table: 'KNVV', where: "KUNNR IN ( '0000100002' , '0000100003' ) AND VKORG = '2000'" });
    expect(system.state).toEqual({ opened: 1, closed: 1 });
  });
});

describe('SalesOrderSearch', () => {
  const VBAK: Row[] = [
    { VBELN: '0000000001', AUDAT: '20250101', KUNNR: '0000100001', NETWR: '100.00', WAERK: 'NOK', VBTYP: 'C' },
    { VBELN: '0000000004', AUDAT: '20260908', KUNNR: '0000100001', NETWR: '400.00', WAERK: 'NOK', VBTYP: 'C' },
    { VBELN: '0000000002', AUDAT: '20250601', KUNNR: '0000100001', NETWR: '50.00-', WAERK: 'NOK', VBTYP: 'C' },
    { VBELN: '0000000003', AUDAT: '20260908', KUNNR: '0000100001', NETWR: '300.00', WAERK: 'NOK', VBTYP: 'C' },
  ];
  const KNA1: Row[] = [{ KUNNR: '0000100001', NAME1: 'Fjordheim Digital AS', ORT01: 'Drammen' }];

  it('returns the newest orders even though SAP cannot sort, with the customer name', async () => {
    const system = sap({ tables: { VBAK, KNA1 } });
    const { body } = await system.call('SalesOrderSearch', { customer: '100001', maxRows: 2 });
    expect(body).toMatchObject({ rowCount: 2, matchCount: 4, moreRowsPossible: true });
    expect(body.orders).toEqual([
      { salesOrder: '4', category: 'C', documentDate: '2026-09-08', soldTo: '100001', soldToName: 'Fjordheim Digital AS', soldToCity: 'Drammen', netValue: 400, currency: 'NOK' },
      { salesOrder: '3', category: 'C', documentDate: '2026-09-08', soldTo: '100001', soldToName: 'Fjordheim Digital AS', soldToCity: 'Drammen', netValue: 300, currency: 'NOK' },
    ]);
    const [candidates, full] = system.reads();
    expect(candidates).toEqual({ table: 'VBAK', fields: ['VBELN', 'AUDAT'], where: "VBTYP = 'C' AND KUNNR = '0000100001'" });
    expect(full!.where).toBe("VBELN IN ( '0000000004' , '0000000003' )");
  });

  it('reads the items table for a material, with the material number SAP stores', async () => {
    const system = sap({ tables: { VBAP: [{ VBELN: '0000000002', POSNR: '000010' }], VBAK, KNA1 } });
    const { body } = await system.call('SalesOrderSearch', { material: '4711' });
    expect(system.reads()[0]).toMatchObject({ table: 'VBAP', where: "MATNR = '000000000000004711'" });
    expect(body.orders.map((order: { salesOrder: string; netValue: number }) => [order.salesOrder, order.netValue])).toEqual([['2', -50]]);
  });

  it("keeps a quote in the customer's PO number inside the literal", async () => {
    const system = sap({ tables: { VBAK } });
    await system.call('SalesOrderSearch', { customerPo: "PO'7" });
    expect(system.reads()[0]!.where).toBe("VBTYP = 'C' AND BSTNK LIKE '%PO''7%'");
  });

  it("honours the operator's table list before logging on", async () => {
    const system = sap({ extra: { RFC_MCP_TABLES: 'KNA1' } });
    const { body } = await system.call('SalesOrderSearch', { customer: '100001' });
    expect(body).toMatchObject({ dispatched: false, error: { code: 'table_not_allowed' } });
    expect(system.state.opened).toBe(0);
  });
});

describe('SalesOrderDetails', () => {
  const order = {
    ORDER_HEADERS_OUT: [
      { DOC_NUMBER: '0005000123', DOC_TYPE: 'YOR', SD_DOC_CAT: 'C', SALES_ORG: '2000', NET_VAL_HD: '965.000000000', CURRENCY: 'NOK', SOLD_TO: '0000100001', PURCH_NO: 'PO-1001', SHIP_COND: 'Z1', REQ_DATE_H: '20250516' },
    ],
    ORDER_ITEMS_OUT: [
      { ITM_NUMBER: '000010', MATERIAL: 'CHAIR100A', SHORT_TEXT: 'Recliner chair', REQ_QTY: '1.000', SALES_UNIT: 'EA', NET_PRICE: '965.000000000', COND_P_UNT: '1', COND_UNIT: 'EA', NET_VALUE: '965.000000000', TAX_AMOUNT: '241.250000000', CURRENCY: 'NOK', PLANT: '1001', SHIP_POINT: '1001', ROUTE: 'NO115', GROSS_WEIG: '26.000', UNIT_OF_WT: 'KG', HG_LV_ITEM: '000000' },
    ],
    ORDER_SCHEDULES_OUT: [{ ITM_NUMBER: '000010', SCHED_LINE: '0001', REQ_DATE: '20250516', REQ_QTY: '1.000', CONFIR_QTY: '1.000', SALES_UNIT: 'EA', GI_DATE: '20250516', MS_DATE: '20250514' }],
    ORDER_BUSINESS_OUT: [{ ITM_NUMBER: '000000', INCOTERMS1: 'CIP', INCOTERMS2: 'Moss', PMNTTRMS: '0090', PRICE_DATE: '20250417' }],
    ORDER_PARTNERS_OUT: [
      { ITM_NUMBER: '000000', PARTN_ROLE: 'WE', CUSTOMER: '0010000101', PERSON_NO: '00000000', CONTACT: '0000000000', ADDRESS: '0001000001' },
    ],
    ORDER_ADDRESS_OUT: [{ ADDRESS: '0001000001', NAME: 'Fjordheim Digital AS', STREET: 'Lagerveien', HOUSE_NO_LONG: '10', POSTL_CODE: '1530', CITY: 'Moss', COUNTRY: 'NO' }],
    ORDER_STATUSHEADERS_OUT: [{ PRC_STAT_H: 'B', DLV_STAT_H: 'B', OVERALLREJ: 'A', TOTINCOMPL: 'C' }],
    ORDER_STATUSITEMS_OUT: [{ ITM_NUMBER: '000010', OVRPROCSTA: 'C', DLV_STAT_I: 'C', REJSTATIT: 'A' }],
    ORDER_CONDITIONS_OUT: [
      { ITM_NUMBER: '000010', COND_ST_NO: '014', COND_TYPE: '', CONDVALUE: '600.0' },
      { ITM_NUMBER: '000010', COND_ST_NO: '020', COND_COUNT: '01', COND_TYPE: 'ZVA0', CALCTYPCON: 'C', COND_VALUE: '1000.000000000', CURRENCY: 'NOK', COND_P_UNT: '1', COND_D_UNT: 'EA', CONDVALUE: '1000.000000000', SDCURRENCY: 'NOK' },
      { ITM_NUMBER: '000010', COND_ST_NO: '133', COND_COUNT: '01', COND_TYPE: 'ZK07', CALCTYPCON: 'A', COND_VALUE: '-3.500000000', CONDVALUE: '-35.000000000' },
      { ITM_NUMBER: '000010', COND_ST_NO: '935', COND_COUNT: '01', COND_TYPE: 'YI01', CALCTYPCON: 'C', COND_VALUE: '600.0', STAT_CON: 'X', CONDVALUE: '600.0' },
      { ITM_NUMBER: '000010', COND_ST_NO: '020', COND_COUNT: '02', COND_TYPE: 'ZVA1', CALCTYPCON: 'C', COND_VALUE: '9000.0', CONDISACTI: 'Y', CONDVALUE: '9000.0' },
    ],
    ORDER_FLOWS_OUT: [
      { PRECSDDOC: '0005000123', PREDITDOC: '000010', SUBSSDDOC: '0080000123', DOCCATEGOR: 'J', CREAT_DATE: '20250418', LEVELFLOWR: '01' },
      { PRECSDDOC: '0080000123', PREDITDOC: '000010', SUBSSDDOC: '9000000123', DOCCATEGOR: 'M', CREAT_DATE: '20250418', LEVELFLOWR: '02' },
    ],
    ORDER_CREDITCARDS_OUT: [{ CC_NUMBER: '4111111111111111' }],
  };
  const tables = {
    LIKP: [{ VBELN: '0080000123', LFART: 'YLF', LFDAT: '20250516', WADAT: '20250516', WADAT_IST: '20250418', ROUTE: 'NO115', BTGEW: '60.500', GEWEI: 'KG' }],
    T685T: [
      { KSCHL: 'ZVA0', VTEXT: 'Retail Price (Basic)' },
      { KSCHL: 'ZK07', VTEXT: 'Customer Disc. (%)' },
    ],
    TVZBT: [{ ZTERM: '0090', VTEXT: '90 days net' }],
    TVROT: [{ ROUTE: 'NO115', BEZEI: 'Norway South' }],
  };

  it('reads one order with its prices, terms and logistics, and never asks for card data', async () => {
    const system = sap({ functions: { BAPISDORDER_GETDETAILEDLIST: order }, tables });
    const { isError, body } = await system.call('SalesOrderDetails', { salesOrder: '5000123' });
    expect(isError).toBe(false);
    const bapi = system.calls[0]!;
    expect(bapi).toEqual({ functionName: 'BAPISDORDER_GETDETAILEDLIST', parameters: { I_BAPI_VIEW: ORDER_VIEWS, SALES_DOCUMENTS: [{ VBELN: '0005000123' }] } });
    expect(bapi.parameters.I_BAPI_VIEW).not.toHaveProperty('CREDCARD');
    expect(JSON.stringify(body)).not.toContain('4111111111111111');

    expect(body.header).toMatchObject({ salesOrder: '5000123', orderType: 'YOR', soldTo: '100001', customerPo: 'PO-1001', requestedDeliveryDate: '2025-05-16' });
    expect(body.totals).toEqual({ netValue: 965, tax: 241.25, grossValue: 1206.25, currency: 'NOK' });
    expect(body.status).toEqual({ overall: 'partially processed', delivery: 'partially processed', rejection: 'nothing rejected', completeness: 'complete' });
    expect(body.terms).toMatchObject({ incoterms: 'CIP', incotermsPlace: 'Moss', paymentTerms: '0090', paymentTermsName: '90 days net' });
    expect(body.partners).toEqual([
      { role: 'ship-to', roleCode: 'WE', customer: '10000101', name: 'Fjordheim Digital AS', street: 'Lagerveien 10', postalCode: '1530', city: 'Moss', country: 'NO' },
    ]);

    const [item] = body.items;
    expect(item).toMatchObject({ item: '10', material: 'CHAIR100A', quantity: 1, netPrice: 965, netValue: 965, tax: 241.25 });
    expect(item.pricing).toEqual([
      { type: 'ZVA0', name: 'Retail Price (Basic)', rate: 1000, rateUnit: 'NOK', per: 1, perUnit: 'EA', value: 1000, currency: 'NOK' },
      { type: 'ZK07', name: 'Customer Disc. (%)', rate: -3.5, rateUnit: '%', value: -35, currency: 'NOK' },
    ]);
    expect(item.logistics).toMatchObject({ plant: '1001', route: 'NO115', routeName: 'Norway South', grossWeight: 26, weightUnit: 'KG' });
    expect(item.scheduleLines).toEqual([{ line: '1', deliveryDate: '2025-05-16', orderedQuantity: 1, confirmedQuantity: 1, unit: 'EA', materialAvailability: '2025-05-14', goodsIssue: '2025-05-16' }]);

    expect(body.deliveries).toEqual([
      { delivery: '80000123', type: 'YLF', deliveryDate: '2025-05-16', plannedGoodsIssue: '2025-05-16', actualGoodsIssue: '2025-04-18', goodsIssued: true, route: 'NO115', routeName: 'Norway South', grossWeight: 60.5, weightUnit: 'KG' },
    ]);
    expect(body.documentFlow).toEqual([
      { document: '80000123', category: 'Delivery', createdOn: '2025-04-18', precededBy: '5000123', orderItems: ['10'], level: 1 },
      { document: '9000000123', category: 'Invoice', createdOn: '2025-04-18', precededBy: '80000123', level: 2 },
    ]);
    expect(body.warnings).toBeUndefined();
    expect(system.state).toEqual({ opened: 1, closed: 1 });
  });

  it('lists statistical and inactive conditions only on request', async () => {
    const system = sap({ functions: { BAPISDORDER_GETDETAILEDLIST: order }, tables });
    const { body } = await system.call('SalesOrderDetails', { salesOrder: '5000123', includeStatisticalConditions: true });
    expect(body.items[0].pricing.map((row: { type: string }) => row.type)).toEqual(['ZVA0', 'ZVA1', 'ZK07', 'YI01']);
  });

  it('still answers when a name lookup is refused, and says what is missing', async () => {
    const refused = Object.assign(new Error('NOT_AUTHORIZED'), { key: 'NOT_AUTHORIZED' });
    const system = sap({ functions: { BAPISDORDER_GETDETAILEDLIST: order }, tables: { ...tables, T685T: refused } });
    const { isError, body } = await system.call('SalesOrderDetails', { salesOrder: '5000123' });
    expect(isError).toBe(false);
    expect(body.items[0].pricing[0]).not.toHaveProperty('name');
    expect(body.warnings).toEqual([{ lookup: 'T685T texts', blocker: 'table_auth', detail: 'NOT_AUTHORIZED | NOT_AUTHORIZED' }]);
  });

  it('skips name tables the operator has not enabled, without a warning', async () => {
    const system = sap({ extra: { RFC_MCP_TABLES: 'LIKP' }, functions: { BAPISDORDER_GETDETAILEDLIST: order }, tables });
    const { body } = await system.call('SalesOrderDetails', { salesOrder: '5000123' });
    expect(system.reads().map((read) => read.table)).toEqual(['LIKP']);
    expect(body.warnings).toBeUndefined();
    expect(body.deliveries[0].delivery).toBe('80000123');
  });

  it('says when an order does not exist', async () => {
    const system = sap({ functions: { BAPISDORDER_GETDETAILEDLIST: { ORDER_HEADERS_OUT: [] } } });
    const { isError, body } = await system.call('SalesOrderDetails', { salesOrder: '9999999' });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ dispatched: true, error: { code: 'not_found' } });
  });
});
