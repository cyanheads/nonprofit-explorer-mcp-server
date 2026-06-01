/**
 * @fileoverview ProPublica Nonprofit Explorer API v2 service layer.
 * Keyless, read-only REST wrapper — search and org-profile endpoints.
 * @module services/nonprofit-explorer/nonprofit-explorer-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { RawOrgResponse, RawSearchResponse, SearchParams } from './types.js';

const BASE_URL = 'https://projects.propublica.org/nonprofits/api/v2';

export class NonprofitExplorerService {
  // AppConfig and StorageService are injected for future extensibility (caching, config flags)
  // but are not referenced directly by this keyless, stateless service.
  constructor(_config: AppConfig, _storage: StorageService) {}

  /** Search organizations by keyword and optional filters. */
  search(params: SearchParams, ctx: Context): Promise<RawSearchResponse> {
    const rctx = ctx as unknown as RequestContext;
    return withRetry(
      async () => {
        const url = new URL(`${BASE_URL}/search.json`);
        if (params.query) url.searchParams.set('q', params.query);
        if (params.state) url.searchParams.set('state[id]', params.state);
        if (params.ntee_category) url.searchParams.set('ntee[id]', params.ntee_category);
        if (params.subsection_code) url.searchParams.set('c_code[id]', params.subsection_code);
        url.searchParams.set('page', String(params.page));

        ctx.log.debug('Searching nonprofits', { url: url.toString() });
        const response = await fetchWithTimeout(url.toString(), 15_000, rctx, {
          signal: ctx.signal,
          headers: { Accept: 'application/json' },
        });
        const text = await response.text();
        return this.parseJson<RawSearchResponse>(text, url.toString());
      },
      {
        operation: 'NonprofitExplorer.search',
        context: rctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch full organization profile and all filings by EIN.
   * Handles the three not-found signatures and throws notFound when detected.
   */
  getOrganization(ein: number, ctx: Context): Promise<RawOrgResponse> {
    const rctx = ctx as unknown as RequestContext;
    return withRetry(
      async () => {
        const url = `${BASE_URL}/organizations/${ein}.json`;
        ctx.log.debug('Fetching nonprofit org', { ein });

        // fetchWithTimeout maps HTTP 404 → NotFound, which withRetry will not retry (non-transient).
        const response = await fetchWithTimeout(url, 15_000, rctx, {
          signal: ctx.signal,
          headers: { Accept: 'application/json' },
        });

        const text = await response.text();

        // Detect HTML 500 responses masquerading as ok
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            `ProPublica API returned HTML instead of JSON for EIN ${ein} — likely a transient server error.`,
            { ein, reason: 'upstream_error' },
          );
        }

        let data: RawOrgResponse;
        try {
          data = JSON.parse(text) as RawOrgResponse;
        } catch {
          throw serviceUnavailable(`ProPublica API returned unparseable response for EIN ${ein}.`, {
            ein,
            reason: 'upstream_error',
          });
        }

        const org = data.organization;

        // Not-found pattern 2: HTTP 200 + id=0
        if (!org || org.id === 0) {
          throw notFound(`No organization found for EIN ${ein}.`, {
            ein,
            reason: 'not_found',
          });
        }

        // Not-found pattern 3: HTTP 200 + name="Unknown Organization" + address=null
        if (org.name === 'Unknown Organization' && org.address === null) {
          throw notFound(`No organization found for EIN ${ein}.`, {
            ein,
            reason: 'not_found',
          });
        }

        return data;
      },
      {
        operation: 'NonprofitExplorer.getOrganization',
        context: rctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /** Parse JSON from an upstream response; throws serviceUnavailable on HTML error pages. */
  private parseJson<T>(text: string, url: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'ProPublica API returned HTML instead of JSON — likely a transient server error.',
        { url, reason: 'upstream_error' },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw serviceUnavailable('ProPublica API returned unparseable response.', {
        url,
        reason: 'upstream_error',
      });
    }
  }
}

// --- Init/accessor pattern ---

let _service: NonprofitExplorerService | undefined;

export function initNonprofitExplorerService(config: AppConfig, storage: StorageService): void {
  _service = new NonprofitExplorerService(config, storage);
}

export function getNonprofitExplorerService(): NonprofitExplorerService {
  if (!_service) {
    throw new Error(
      'NonprofitExplorerService not initialized — call initNonprofitExplorerService() in setup()',
    );
  }
  return _service;
}

/** Normalize an EIN input (number or string with/without hyphen) to an integer. */
export function normalizeEin(ein: number | string): number {
  if (typeof ein === 'number') return ein;
  return parseInt(ein.replace('-', ''), 10);
}
