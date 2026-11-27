// The scope of this server, in executable form. Three guardrails hold whatever the SAP user is
// authorized for:
//   (1) the function modules callable without an approval are FIXED here, not configured;
//   (2) a sensitive-table denylist always applies;
//   (3) the server is off until an operator switches it on for one system.
// What an operator may add locally (RFC_MCP_EXTENDED_FUNCTIONS) is deliberately a separate tool with a
// separate name, so an MCP host can require an approval for every call to it.

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Function modules callable through `RfcCall`. All are reads; adding one is a reviewed code change. */
export const FIXED_READ_FUNCTIONS: Readonly<Record<string, string>> = {
  RFC_SYSTEM_INFO: 'system id, release, kernel, host and code page',
  '/SDF/UPL_SYSTEM_STATUS': 'whether usage logging (UPL) is active and since when',
  SCMON_GET_LOG_STATUS: 'ABAP call monitor (SCMON) collection status',
  SWNC_GET_DIRECTORY_FRAME: 'workload statistics (ST03N) periods available',
  RPY_PROGRAM_READ: 'program source with includes',
  RFC_READ_REPORT: 'raw report source',
};

/** Used by this server's own tools. Never callable by name, so the table gate cannot be bypassed. */
export const TABLE_READER = 'RFC_READ_TABLE';
export const INTERFACE_READER = 'RFC_GET_FUNCTION_INTERFACE';

/**
 * Never callable, whatever the operator lists. Code and OS execution, user administration, commits,
 * monitoring switches, and every generic table reader (table reads go through `RfcReadTable` so the
 * sensitive-table denylist always applies).
 */
export const DENIED_FUNCTIONS: ReadonlySet<string> = new Set([
  'RFC_ABAP_INSTALL_AND_RUN',
  'RFC_REMOTE_EXEC',
  'RFC_REMOTE_PIPE',
  'RFC_REMOTE_FILE',
  'RS_ABAP_INIT_ANALYSIS',
  '/SDF/UPL_CONTROL',
  'SCMON_ACTIVATE',
  'SCMON_DEACTIVATE',
  'BAPI_TRANSACTION_COMMIT',
  'TRINT_RELEASE_REQUEST',
  TABLE_READER,
  'BBP_RFC_READ_TABLE',
  '/BODS/RFC_READ_TABLE',
  '/BODS/RFC_READ_TABLE2',
  '/SAPDS/RFC_READ_TABLE',
  '/SAPDS/RFC_READ_TABLE2',
  'TABLE_ENTRIES_GET_VIA_RFC',
  'GET_TABLE_RFC',
]);
export const DENIED_FUNCTION_PREFIXES: readonly string[] = ['SXPG_', 'BAPI_USER_', 'SUSR_'];

/**
 * Tables refused regardless of SAP authorization: HR master data and payroll clusters, password
 * hashes, stored RFC and secure-store credentials, key material and payment-card numbers. This is a
 * floor, not a data-protection classification of the customer's system; RFC_MCP_TABLES narrows further.
 */
export const SENSITIVE_TABLES: ReadonlySet<string> = new Set([
  'USR02',
  'USH02',
  'USRPWDHISTORY',
  'RFCDES',
  'RSECTAB',
  'RSECACTB',
  'ICFSERVLOC',
  'PPOIX',
  'PPOPX',
  'VCNUM',
  'CCARDEC',
]);
export const SENSITIVE_TABLE_PATTERNS: readonly RegExp[] = [
  /^PA\d{4}$/,
  /^PB\d{4}$/,
  /^HRP\d{4}$/,
  /^PCL\d$/,
  /^HRPY_/,
  /^SSF_PSE/,
];

const NAME = /^[A-Z0-9_/]{1,30}$/;

/** Upper-cases and validates a function module, table or field name. Nothing else reaches SAP. */
export function normalizeName(value: string, kind: string): string {
  const name = value.trim().toUpperCase();
  if (!NAME.test(name)) throw new PolicyError('invalid_name', `${kind} name is not a valid SAP name.`);
  return name;
}

export function isDeniedFunction(name: string): boolean {
  return DENIED_FUNCTIONS.has(name) || DENIED_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isSensitiveTable(name: string): boolean {
  return SENSITIVE_TABLES.has(name) || SENSITIVE_TABLE_PATTERNS.some((pattern) => pattern.test(name));
}

export interface RfcConnection {
  ashost: string;
  sysnr: string;
  client: string;
  user: string;
  passwd: string;
  lang: string;
}

export interface Policy {
  connection: RfcConnection;
  timeoutSeconds: number;
  /** Ceiling for one table read; a call may ask for fewer rows, never more. */
  maxRows: number;
  /** Operator-listed function modules, reachable only through the approval-gated tool. */
  extendedFunctions: ReadonlySet<string>;
  /** When set, the only tables readable. The sensitive-table denylist applies either way. */
  tables: ReadonlySet<string> | null;
}

export type Env = Readonly<Record<string, string | undefined>>;

const ROW_CEILING = 5000;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function bounded(env: Env, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new PolicyError('invalid_config', `${key} must be a whole number from 1 to ${max}.`);
  return value;
}

/** Reads the whole configuration once at startup. Throws before any connection is attempted. */
export function loadPolicy(env: Env): Policy {
  if (env.RFC_MCP_ENABLED !== 'true')
    throw new PolicyError('disabled', 'RFC access is off. Set RFC_MCP_ENABLED=true for this system to enable it.');
  const required = ['SAP_RFC_ASHOST', 'SAP_CLIENT', 'SAP_USER', 'SAP_PASSWORD'] as const;
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) throw new PolicyError('invalid_config', `Missing ${missing.join(', ')}.`);
  const sysnr = (env.SAP_RFC_SYSNR ?? '00').padStart(2, '0');
  if (!/^\d{2}$/.test(sysnr)) throw new PolicyError('invalid_config', 'SAP_RFC_SYSNR must be one or two digits.');
  if (!/^\d{3}$/.test(env.SAP_CLIENT!)) throw new PolicyError('invalid_config', 'SAP_CLIENT must be three digits.');

  const extendedFunctions = new Set<string>();
  for (const entry of list(env.RFC_MCP_EXTENDED_FUNCTIONS)) {
    const name = normalizeName(entry, 'RFC_MCP_EXTENDED_FUNCTIONS entry');
    if (isDeniedFunction(name))
      throw new PolicyError('denied_function', `${name} is on the deny list and cannot be enabled.`);
    extendedFunctions.add(name);
  }
  let tables: Set<string> | null = null;
  if (env.RFC_MCP_TABLES) {
    tables = new Set();
    for (const entry of list(env.RFC_MCP_TABLES)) {
      const name = normalizeName(entry, 'RFC_MCP_TABLES entry');
      if (isSensitiveTable(name))
        throw new PolicyError('sensitive_table', `${name} is on the sensitive-table list and cannot be enabled.`);
      tables.add(name);
    }
  }
  return {
    connection: {
      ashost: env.SAP_RFC_ASHOST!,
      sysnr,
      client: env.SAP_CLIENT!,
      user: env.SAP_USER!,
      passwd: env.SAP_PASSWORD!,
      lang: env.SAP_LANGUAGE ?? 'EN',
    },
    timeoutSeconds: bounded(env, 'RFC_MCP_TIMEOUT_SECONDS', 25, 300),
    maxRows: bounded(env, 'RFC_MCP_MAX_ROWS', 200, ROW_CEILING),
    extendedFunctions,
    tables,
  };
}

export function assertFixedFunction(value: string): string {
  const name = normalizeName(value, 'Function module');
  if (isDeniedFunction(name)) throw new PolicyError('denied_function', `${name} is on the deny list.`);
  if (!(name in FIXED_READ_FUNCTIONS))
    throw new PolicyError('function_not_allowed', `${name} is not one of the fixed read function modules.`);
  return name;
}

export function assertExtendedFunction(policy: Policy, value: string): string {
  const name = normalizeName(value, 'Function module');
  if (isDeniedFunction(name)) throw new PolicyError('denied_function', `${name} is on the deny list.`);
  if (!policy.extendedFunctions.has(name))
    throw new PolicyError('function_not_allowed', `${name} has not been enabled for this system by its operator.`);
  return name;
}

export function assertReadableTable(policy: Policy, value: string): string {
  const name = normalizeName(value, 'Table');
  if (isSensitiveTable(name))
    throw new PolicyError('sensitive_table', `${name} is on the sensitive-table list and is never read.`);
  if (policy.tables && !policy.tables.has(name))
    throw new PolicyError('table_not_allowed', `${name} has not been enabled for this system by its operator.`);
  return name;
}
