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
  setup(core) {
    initNonprofitExplorerService(core.config, core.storage);
  },
  instructions:
    'ProPublica Nonprofit Explorer — keyless read-only access to IRS Form 990 data on 1.8M+ tax-exempt organizations.\n' +
    '- Start with nonprofit_search to find an org by name and get its EIN\n' +
    '- Use nonprofit_get_organization for the full profile and latest financial snapshot\n' +
    '- Use nonprofit_get_filings for year-by-year 990 data, program expense ratios, executive comp, and PDF links\n' +
    '- Data lags 1–2 years; always cite the fiscal year (tax_prd_yr) when presenting financial figures',
});
