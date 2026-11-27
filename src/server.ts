import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FIXED_READ_FUNCTIONS } from './policy.js';
import { callExtended, callFixed, callSchema, describeFunction, describeSchema, readTable, readTableSchema, type ToolContext } from './tools.js';

export const SERVER_VERSION = '0.1.0';

/**
 * The tool names are a contract with the MCP host. RfcDescribeFunction, RfcReadTable and RfcCall are
 * reads by construction. RfcCallExtended reaches whatever an operator listed and should always need
 * an approval. Renaming a tool changes how a host that gates by name treats it.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'rfc-mcp', version: SERVER_VERSION });
  const fixed = Object.entries(FIXED_READ_FUNCTIONS)
    .map(([name, purpose]) => `${name} (${purpose})`)
    .join('; ');

  server.registerTool(
    'RfcDescribeFunction',
    {
      description:
        'Read the interface of one SAP function module: its import, export, changing and tables parameters, their types, and which tool can call it. Use this before a call; parameter names are case-sensitive.',
      inputSchema: describeSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => describeFunction(ctx, args)
  );
  server.registerTool(
    'RfcReadTable',
    {
      description: `Read rows of one SAP table over RFC. Name the fields you need (a row is limited to 512 bytes in total) and narrow with "where" in Open SQL syntax, for example MANDT = '100' AND MTART = 'FERT'. At most ${ctx.policy.maxRows} rows per call; page with skipRows. HR, payroll, password and credential tables are never readable.`,
      inputSchema: readTableSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => readTable(ctx, args)
  );
  server.registerTool(
    'RfcCall',
    {
      description: `Call one of the fixed read-only SAP function modules: ${fixed}. No other function module is callable with this tool.`,
      inputSchema: callSchema.shape,
      annotations: { readOnlyHint: true },
    },
    (args) => callFixed(ctx, args)
  );
  if (ctx.policy.extendedFunctions.size > 0)
    server.registerTool(
      'RfcCallExtended',
      {
        description: `Call a function module this system's operator has enabled: ${[...ctx.policy.extendedFunctions].join(', ')}. Each call needs an approval. The session ends without a commit, so a BAPI that needs BAPI_TRANSACTION_COMMIT does not persist its changes; a function module that commits by itself does. A failed or timed-out call may still have had an effect: check before repeating it.`,
        inputSchema: callSchema.shape,
        annotations: { readOnlyHint: false },
      },
      (args) => callExtended(ctx, args)
    );
  return server;
}
