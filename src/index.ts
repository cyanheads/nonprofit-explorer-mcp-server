#!/usr/bin/env node
/**
 * @fileoverview nonprofit-explorer-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { nonprofitGetFilings } from './mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import { nonprofitGetOrganization } from './mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import { nonprofitSearch } from './mcp-server/tools/definitions/nonprofit-search.tool.js';
import { initNonprofitExplorerService } from './services/nonprofit-explorer/nonprofit-explorer-service.js';

await createApp({
  name: 'nonprofit-explorer-mcp-server',
  title: 'nonprofit-explorer-mcp-server',
  tools: [nonprofitSearch, nonprofitGetOrganization, nonprofitGetFilings],
  resources: [],
  prompts: [],
  /**
   * The tool list is fixed at build time — three unconditional registrations, no
   * feature gate, no auth scope, nothing that emits `toolsChanged` — so every
   * client is served identical bytes and a shared cache may hold one copy. An
   * hour bounds how long a client can hold a list minted before a redeploy.
   * Honored on protocol revision 2026-07-28 only; 2025-era responses are unchanged.
   */
  cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' } },
  /**
   * Read-only wrapper over a keyless public API: no handler calls `ctx.requestInput`,
   * and `ctx.state` is tenant-scoped storage rather than the session store, so nothing
   * here needs a durable session. Declared in code so a deployment that never sets
   * `MCP_SESSION_MODE` still resolves stateless; the env var still wins when set.
   */
  sessionMode: 'stateless',
  setup(core) {
    initNonprofitExplorerService(core.config, core.storage);
  },
  instructions:
    'ProPublica Nonprofit Explorer — keyless read-only access to IRS Form 990 data on 1.8M+ tax-exempt organizations.\n' +
    '- Start with nonprofit_search to find an org by name and get its EIN\n' +
    '- Use nonprofit_get_organization for the full profile and latest financial snapshot\n' +
    '- Use nonprofit_get_filings for year-by-year 990 data, executive comp, and source PDF links\n' +
    '- Data lags 1–2 years; always cite the fiscal year (tax_prd_yr) when presenting financial figures',
});
