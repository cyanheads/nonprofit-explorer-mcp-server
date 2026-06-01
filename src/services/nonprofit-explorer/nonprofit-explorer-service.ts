/**
 * @fileoverview ProPublica Nonprofit Explorer API v2 service layer.
 * Keyless, read-only REST wrapper — search and org-profile endpoints.
 * @module services/nonprofit-explorer/nonprofit-explorer-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { RawOrgResponse, RawSearchResponse, SearchParams } from './types.js';

const BASE_URL = 'https://projects.propublica.org/nonprofits/api/v2';
const FETCH_TIMEOUT_MS = 15_000;

export class NonprofitExplorerService {
  // AppConfig and StorageService are injected for future extensibility (caching, config flags)
  // but are not referenced directly by this keyless, stateless service.
  constructor(_config: AppConfig, _storage: StorageService) {}

  /**
   * Fetch a URL with timeout, tolerating specific non-2xx statuses instead of throwing.
   * Returns `{ status, text }` — caller decides whether the status is an error.
   * Throws `serviceUnavailable` on network errors or unexpected non-JSON responses.
   */
  private async fetchTolerant(
    url: string,
    toleratedStatuses: number[],
    ctx: Context,
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // Forward caller's cancellation signal to the AbortController
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        clearTimeout(timeoutId);
        controller.abort(ctx.signal.reason);
      } else {
        ctx.signal.addEventListener('abort', () => controller.abort(ctx.signal.reason), {
          once: true,
          signal: controller.signal,
        });
      }
    }

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      const text = await response.text();

      // Non-2xx that isn't in the tolerated list is a service error
      if (!response.ok && !toleratedStatuses.includes(response.status)) {
        throw serviceUnavailable(`ProPublica API returned unexpected status ${response.status}.`, {
          url,
          statusCode: response.status,
          reason: 'upstream_error',
        });
      }

      return { status: response.status, text };
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw serviceUnavailable(
        `Network error reaching ProPublica API: ${err instanceof Error ? err.message : String(err)}`,
        { url, reason: 'upstream_error' },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

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

        // ProPublica returns HTTP 404 (not 200) when there are zero results — tolerate it
        // so the tool handler can throw the correct no_results contract error.
        const { text } = await this.fetchTolerant(url.toString(), [404], ctx);
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

        // Tolerate 404 — the API returns HTTP 404 + JSON body for "org not found" (not-found
        // pattern 1). We inspect the body before deciding how to classify the error, rather
        // than letting the network layer throw a generic FetchHttpError.
        const { status, text } = await this.fetchTolerant(url, [404], ctx);

        const data = this.parseJson<RawOrgResponse>(text, url);

        // Not-found pattern 1: HTTP 404 + {"error": "Organization not found"}
        if (status === 404) {
          throw notFound(`No organization found for EIN ${ein}.`, {
            ein,
            reason: 'not_found',
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

/**
 * Format an EIN integer as "XX-XXXXXXX" string.
 * EINs are 9 digits; the first two form the prefix. Leading zeros are preserved via padding.
 */
export function formatEin(ein: number): string {
  const s = String(ein).padStart(9, '0');
  return `${s.slice(0, 2)}-${s.slice(2)}`;
}
