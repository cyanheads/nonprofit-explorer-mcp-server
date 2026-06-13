<div align="center">
  <h1>@cyanheads/nonprofit-explorer-mcp-server</h1>
  <p><b>Search and explore 1.8M+ US nonprofits, fetch Form 990 financials, and access IRS filing history via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/nonprofit-explorer-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/nonprofit-explorer-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/nonprofit-explorer-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/nonprofit-explorer-mcp-server/releases/latest/download/nonprofit-explorer-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=nonprofit-explorer-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbm9ucHJvZml0LWV4cGxvcmVyLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22nonprofit-explorer-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnonprofit-explorer-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

3 tools for working with US nonprofit and IRS Form 990 data:

| Tool | Description |
|:---|:---|
| `nonprofit_search` | Search 1.8M+ IRS-recognized tax-exempt organizations by name, keyword, city, or phrase with optional state, NTEE sector, and 501(c) filters |
| `nonprofit_get_organization` | Full profile for one org by EIN: legal identity, IRS classification, ruling date, and a financial snapshot from the most recent Form 990 |
| `nonprofit_get_filings` | All Form 990 filings for an org by EIN: year-by-year financials, program-expense ratio, executive compensation, and source PDF/XML links |

### `nonprofit_search`

Search for tax-exempt organizations across the IRS Nonprofit Explorer dataset.

- Full-text search across org name, alternate name, and city with relevance ranking
- Supports quoted phrases (`"Red Cross"`), required terms (`+evanston`), excluded terms (`-dental`)
- Filter by US state (two-letter abbreviation; `ZZ` for foreign entities)
- Filter by NTEE major sector (Arts, Education, Health, Human Services, etc., 1–10)
- Filter by 501(c) subsection code (e.g., `3` = public charity, `4` = social welfare)
- Paginated at 25 per page; use `page` (zero-indexed) and `num_pages` to walk large result sets
- API caps total results at 10,000; `total_results === 10000` means the actual count may be higher
- Returns EINs — pass to `nonprofit_get_organization` or `nonprofit_get_filings` for details

---

### `nonprofit_get_organization`

Fetch the full profile for a single tax-exempt org by EIN.

- Accepts EIN as integer (`530196605`) or string with or without hyphen (`"53-0196605"`)
- Returns legal name, address, NTEE code, 501(c) type, and IRS ruling date
- Financial snapshot from the most recent Form 990: revenue, expenses, assets, liabilities, net assets
- Includes source 990 PDF link and IRS Business Master File summary figures
- `filing_count` shows how many filings with extracted data are on record
- Data lags 1–2 years; `tax_prd_yr` in the snapshot is the fiscal year of the filing, not the current year
- Use `nonprofit_search` first if you only have an org name

---

### `nonprofit_get_filings`

Fetch the full filing history for an org by EIN.

- All Form 990 filings with extracted financial data, sorted newest first
- Per-filing: revenue, expenses, assets, liabilities, net assets, revenue breakdown (contributions, program service, investment income)
- Program-expense ratio computed from 990 inputs with the full breakdown shown (officer comp, other salaries, fundraising); not available for 990-PF
- Executive compensation summary with field-name transparency and a note pointing to Schedule J for per-officer detail
- Source 990 PDF and XML links per filing
- `filings_pdf_only` lists older filings with a PDF but no extracted data
- Data lags 1–2 years; always cite `tax_prd_yr` (fiscal year) when presenting figures

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

ProPublica Nonprofit Explorer / IRS-specific:

- Keyless access — ProPublica Nonprofit Explorer API requires no API key
- Covers 1.8M+ IRS-recognized tax-exempt organizations
- IRS Form 990 data: annual filings for public charities (990), small orgs (990-EZ), and private foundations (990-PF)
- Source filing links (PDF and XML) on every filing record
- Data sourced from ProPublica Nonprofit Explorer, derived from IRS Form 990 filings; data lags 1–2 years

Agent-friendly output:

- Provenance on every response — `data_source` attribution on all tool outputs, ProPublica URL for direct verification
- Filing-year clarity — `tax_prd_yr` prominently labeled as fiscal year with explicit lag caveat in every financial response
- Program-expense ratio with inputs — ratio is accompanied by the full expense breakdown so agents and users can verify the computation
- Field-name transparency on compensation — `field_name` and `form_type` exposed so agents know exactly which IRS field was read

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "nonprofit-explorer-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/nonprofit-explorer-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "nonprofit-explorer-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/nonprofit-explorer-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "nonprofit-explorer-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/nonprofit-explorer-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — ProPublica Nonprofit Explorer is a keyless public API.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/nonprofit-explorer-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd nonprofit-explorer-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env as needed (no required vars — server works out of the box)
```

## Configuration

All configuration is validated at startup. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_HOST` | HTTP server hostname | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments | — |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) | `false` |

No server-specific required variables. ProPublica Nonprofit Explorer is a keyless public API.

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t nonprofit-explorer-mcp-server .
docker run --rm -p 3010:3010 nonprofit-explorer-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/nonprofit-explorer-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the service. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Three tools for search and financial data. |
| `src/services/nonprofit-explorer` | ProPublica Nonprofit Explorer API client and domain types. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the arrays in `createApp()` in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
