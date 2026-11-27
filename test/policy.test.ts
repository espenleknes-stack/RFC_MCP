import { describe, expect, it } from 'vitest';
import {
  FIXED_READ_FUNCTIONS,
  PolicyError,
  assertExtendedFunction,
  assertFixedFunction,
  assertReadableTable,
  isDeniedFunction,
  loadPolicy,
} from '../src/policy.js';
import { env } from './env.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyError) return error.code;
    throw error;
  }
  return 'no error';
};

describe('startup configuration', () => {
  it('stays off until the operator enables it', () => {
    expect(code(() => loadPolicy({ ...env, RFC_MCP_ENABLED: undefined }))).toBe('disabled');
    expect(code(() => loadPolicy({ ...env, RFC_MCP_ENABLED: 'TRUE' }))).toBe('disabled');
  });

  it('names missing connection settings without echoing values', () => {
    try {
      loadPolicy({ ...env, SAP_PASSWORD: undefined, SAP_CLIENT: '' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe('Missing SAP_CLIENT, SAP_PASSWORD.');
    }
  });

  it('normalizes the connection and applies defaults', () => {
    const policy = loadPolicy(env);
    expect(policy.connection).toEqual({ ashost: 'ecc.example.test', sysnr: '01', client: '100', user: 'RFC_READ', passwd: 's3cret-value', lang: 'EN' });
    expect(policy).toMatchObject({ timeoutSeconds: 25, maxRows: 200, tables: null });
    expect(policy.extendedFunctions.size).toBe(0);
  });

  it('refuses out-of-range limits and malformed client or system number', () => {
    expect(code(() => loadPolicy({ ...env, RFC_MCP_MAX_ROWS: '5001' }))).toBe('invalid_config');
    expect(code(() => loadPolicy({ ...env, RFC_MCP_TIMEOUT_SECONDS: '0' }))).toBe('invalid_config');
    expect(code(() => loadPolicy({ ...env, SAP_CLIENT: '10' }))).toBe('invalid_config');
    expect(code(() => loadPolicy({ ...env, SAP_RFC_SYSNR: 'A0' }))).toBe('invalid_config');
  });

  it('will not start with a denied function module or a sensitive table enabled', () => {
    for (const name of ['RFC_ABAP_INSTALL_AND_RUN', 'rfc_read_table', 'SXPG_COMMAND_EXECUTE', 'BAPI_USER_CREATE1', 'BAPI_TRANSACTION_COMMIT'])
      expect(code(() => loadPolicy({ ...env, RFC_MCP_EXTENDED_FUNCTIONS: `BAPI_MATERIAL_GET_DETAIL, ${name}` }))).toBe('denied_function');
    for (const name of ['PA0008', 'usr02', 'PCL2', 'HRP1001', 'RFCDES', 'SSF_PSE_D'])
      expect(code(() => loadPolicy({ ...env, RFC_MCP_TABLES: `MARA,${name}` }))).toBe('sensitive_table');
    expect(code(() => loadPolicy({ ...env, RFC_MCP_EXTENDED_FUNCTIONS: 'BAPI_*' }))).toBe('invalid_name');
  });
});

describe('call-time gates', () => {
  const policy = loadPolicy({ ...env, RFC_MCP_EXTENDED_FUNCTIONS: 'bapi_material_get_detail', RFC_MCP_TABLES: 'MARA, T001' });

  it('keeps the ungated function set fixed', () => {
    expect(assertFixedFunction(' rfc_system_info ')).toBe('RFC_SYSTEM_INFO');
    expect(code(() => assertFixedFunction('BAPI_MATERIAL_GET_DETAIL'))).toBe('function_not_allowed');
    expect(code(() => assertFixedFunction('RFC_READ_TABLE'))).toBe('denied_function');
    expect(Object.keys(FIXED_READ_FUNCTIONS).filter(isDeniedFunction)).toEqual([]);
  });

  it('reaches operator-enabled function modules only through the extended gate', () => {
    expect(assertExtendedFunction(policy, 'BAPI_MATERIAL_GET_DETAIL')).toBe('BAPI_MATERIAL_GET_DETAIL');
    expect(code(() => assertExtendedFunction(policy, 'RFC_SYSTEM_INFO'))).toBe('function_not_allowed');
    expect(code(() => assertExtendedFunction(policy, 'BAPI_SALESORDER_CREATEFROMDAT2'))).toBe('function_not_allowed');
  });

  it('applies the table list and always the sensitive-table denylist', () => {
    expect(assertReadableTable(policy, 'mara')).toBe('MARA');
    expect(code(() => assertReadableTable(policy, 'KNA1'))).toBe('table_not_allowed');
    const open = loadPolicy(env);
    expect(assertReadableTable(open, 'KNA1')).toBe('KNA1');
    expect(code(() => assertReadableTable(open, 'PA0002'))).toBe('sensitive_table');
    expect(code(() => assertReadableTable(open, "MARA' OR '1"))).toBe('invalid_name');
  });
});
