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
    'ProPublica Nonprofit Explorer provides keyless read-only access to IRS Form 990 data on 1.8M+ tax-exempt organizations. Resolve names to EINs with nonprofit_search_organizations; use nonprofit_get_organization for the profile, latest extracted financial snapshot, and newest-return metadata, then nonprofit_get_filings for financial history and source PDF links. The newest return may be PDF-only and newer than the extracted snapshot. Filings can be selected with inclusive fiscal-year bounds; omitted bounds return the full history. Data typically lags 1–2 years: cite tax_prd_yr and distinguish the tax period from the filing date.',
});
