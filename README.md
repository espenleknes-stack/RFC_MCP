# RFC_MCP

An MCP server that lets a chat assistant call SAP function modules over classic RFC. It is aimed at
SAP ECC, where there is often no OData or ADT surface to use, and works against other ABAP systems
too.

## Built on open-rfc by Marian Zeis

All RFC communication in this project is done by **[open-rfc](https://github.com/marianfoo/open-rfc)**,
an SDK-free TypeScript implementation of the SAP RFC protocol written by Marian Zeis. Because of it,
this server needs no SAP NW RFC SDK, no native addon and no S-user download.

- Source: <https://github.com/marianfoo/open-rfc>
- npm: <https://www.npmjs.com/package/open-rfc>
- Documentation: <https://marianfoo.github.io/open-rfc/>
- Introduction: [Calling SAP RFC from Node.js Without the SDK](https://blog.zeis.de/posts/2026-08-10-open-rfc/)

`open-rfc` is licensed under Apache-2.0 and is itself adapted in part from
[open-rfc-go](https://github.com/oisee/open-rfc-go). This project is independent of both, and is not
affiliated with or endorsed by SAP SE.

## Status

Built and unit-tested against a scripted SAP. **It has not yet been run against a real SAP system.**
Make the first live call `RFC_SYSTEM_INFO` on a non-productive client.

## Tools

| Tool | What it reaches | Intended gating |
| --- | --- | --- |
| `RfcDescribeFunction` | The interface of any function module: parameters, types, and which tool can call it | read |
| `RfcReadTable` | Rows of one table through `RFC_READ_TABLE`, with named fields, an Open SQL selection, a row cap and paging | read |
| `RfcCall` | A fixed set of read-only function modules: `RFC_SYSTEM_INFO`, `/SDF/UPL_SYSTEM_STATUS`, `SCMON_GET_LOG_STATUS`, `SWNC_GET_DIRECTORY_FRAME`, `RPY_PROGRAM_READ`, `RFC_READ_REPORT` | read |
| `RfcCallExtended` | Function modules you list in `RFC_MCP_EXTENDED_FUNCTIONS`, for example a BAPI. Not advertised when the list is empty | require an approval for every call |

Three guardrails are enforced in [`src/policy.ts`](src/policy.ts), whatever the SAP user is
authorized for:

1. **The function modules behind `RfcCall` are fixed in code.** Anything else has to be listed by
   the operator and goes through `RfcCallExtended`.
2. **Sensitive tables are never read:** HR master data and payroll clusters (`PAnnnn`, `PBnnnn`,
   `HRPnnnn`, `PCLn`, `HRPY_*`), password hashes (`USR02`, `USH02`, `USRPWDHISTORY`), stored
   credentials and key material (`RFCDES`, `RSECTAB`, `SSF_PSE*`) and payment-card numbers. The list
   is a floor, not a data-protection classification of your system. Set `RFC_MCP_TABLES` to allow
   only named tables.
3. **Off by default.** The process exits unless `RFC_MCP_ENABLED=true`.

Never callable, even if listed: `RFC_ABAP_INSTALL_AND_RUN`, `RFC_REMOTE_*`, `SXPG_*` (operating
system commands), `BAPI_USER_*` and `SUSR_*` (user administration), `BAPI_TRANSACTION_COMMIT`, and
every generic table reader. The server refuses to start with one of them, or with a sensitive table,
in its configuration.

## Limits

- **No transport encryption.** Classic RFC without SNC sends the password and the data in clear
  text. Run the server on a trusted private network next to the SAP system, never across an
  untrusted one. `open-rfc` does not support SNC, X.509, SAProuter or message-server logon.
- **Release band.** `open-rfc` 0.2.6 is beta, qualified by its author on SAP NetWeaver 7.50 and SAP
  S/4HANA 2023. ECC 6.0 EHP8 runs on 7.50. Older ECC releases and non-Unicode systems are untested
  or unsupported. Check the `open-rfc` documentation for the current support boundary.
- **Nothing is committed.** Each call logs on, runs one function module and logs off. A BAPI that
  needs `BAPI_TRANSACTION_COMMIT` therefore does not persist its changes. A function module that
  commits by itself does, so list only what you have reviewed.
- **A failed call is not proof of no effect.** After a timeout or a dropped connection the outcome
  is unknown. The server never retries.
- **UCON and gateway ACLs still apply.** A hardened system may refuse RFC outright. Errors carry a
  cause (`ucon`, `gateway_acl`, `rfc_auth`, `table_auth`, `row_512`, `logon`, `unreachable`,
  `absent`) so a Basis team knows what to change.
- **One technical user.** Calls run as the configured SAP user, not as the person in the chat.
- **`RFC_READ_TABLE` limits.** A row is at most 512 bytes across the selected fields, and some field
  types are not readable. Name only the fields you need.

## Install

Requires Node.js 22.14 or later.

```sh
git clone https://github.com/espenleknes-stack/RFC_MCP.git
cd RFC_MCP
npm ci --ignore-scripts
npm run build
```

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `RFC_MCP_ENABLED` | yes | Must be exactly `true` |
| `SAP_RFC_ASHOST` | yes | Application server host |
| `SAP_RFC_SYSNR` | no | System number, default `00` (gateway port `33NN`) |
| `SAP_CLIENT` | yes | Three-digit client |
| `SAP_USER`, `SAP_PASSWORD` | yes | Technical RFC user. Take the password from a secret store, not a committed file |
| `SAP_LANGUAGE` | no | Default `EN` |
| `RFC_MCP_EXTENDED_FUNCTIONS` | no | Comma-separated function modules for `RfcCallExtended`. Exact names, no wildcards |
| `RFC_MCP_TABLES` | no | Comma-separated tables. When set, only these are readable |
| `RFC_MCP_MAX_ROWS` | no | Row ceiling per table read, default 200, at most 5000 |
| `RFC_MCP_TIMEOUT_SECONDS` | no | Per-call timeout, default 25 |

Give the SAP user `S_RFC` for the function groups it calls and `S_TABU_DIS` (or `S_TABU_NAM`) for
the tables it reads, and no more than the tools are meant to reach.

## Use it from an MCP client

The server speaks MCP over stdio. A typical client entry:

```json
{
  "mcpServers": {
    "sap-ecc-rfc": {
      "command": "node",
      "args": ["/absolute/path/to/RFC_MCP/dist/index.js"],
      "env": {
        "RFC_MCP_ENABLED": "true",
        "SAP_RFC_ASHOST": "ecc-app01.corp.example.com",
        "SAP_RFC_SYSNR": "00",
        "SAP_CLIENT": "100",
        "SAP_USER": "RFC_CHAT",
        "SAP_PASSWORD": "<from your secret store>",
        "RFC_MCP_EXTENDED_FUNCTIONS": "BAPI_MATERIAL_GET_DETAIL"
      }
    }
  }
}
```

A good first conversation: ask for the system information (`RfcCall` with `RFC_SYSTEM_INFO`), then
describe a function module with `RfcDescribeFunction` before calling it. Parameter names are
case-sensitive and follow the function module's interface.

Configure your MCP host to ask for approval before `RfcCallExtended`. The server marks it with
`readOnlyHint: false`; the three other tools carry `readOnlyHint: true`.

## Development

```sh
npm test            # builds, then runs the unit tests and starts the built entry point
npm run typecheck
npm run pack:check
```

Logs go to stderr as one JSON object per event: tool, function module, outcome, cause and duration.
Parameters, rows and credentials are never logged.

## Trademarks

SAP, ABAP, SAP ECC, SAP S/4HANA and SAP NetWeaver are trademarks or registered trademarks of SAP SE
or its affiliates.
