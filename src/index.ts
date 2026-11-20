#!/usr/bin/env node
/**
 * @fileoverview nonprofit-explorer-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { nonprofitGetFilings } from './mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import { nonprofitGetOrganization } from './mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import { nonprofitSearchOrganizations } from './mcp-server/tools/definitions/nonprofit-search-organizations.tool.js';
import { initNonprofitExplorerService } from './services/nonprofit-explorer/nonprofit-explorer-service.js';

await createApp({
  name: 'nonprofit-explorer-mcp-server',
  title: 'nonprofit-explorer-mcp-server',
  tools: [nonprofitSearchOrganizations, nonprofitGetOrganization, nonprofitGetFilings],
  resources: [],
  prompts: [],
  skills: 'skills',
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
    'Resolve organization names to EINs with nonprofit_search_organizations. Use nonprofit_get_organization for the BMF record, latest extracted financial snapshot, newest listed return, and newest rendered e-file when available. Check the period printed on that e-file before citing it. Use nonprofit_get_filings for financial history and period-specific PDFs. Supply inclusive four-digit fiscal years or omit either bound. Data typically lags 1–2 years. Cite tax_prd_yr when reporting financials.',
});
