/**
 * @fileoverview ProPublica Nonprofit Explorer API v2 service layer.
 * Keyless, read-only REST wrapper — search and org-profile endpoints.
 * @module services/nonprofit-explorer/nonprofit-explorer-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { RawOrgResponse, RawSearchResponse, SearchParams } from './types.js';

const BASE_URL = 'https://projects.propublica.org/nonprofits/api/v2';
const FETCH_TIMEOUT_MS = 15_000;

/** Search page size applied by ProPublica; not configurable through the API. */
const SEARCH_RESULTS_PER_PAGE = 25;
/**
 * ProPublica saturates `total_results` at this value and refuses any request whose
 * result offset reaches it. A search reporting exactly this total has hit a ceiling,
 * not counted its matches.
 */
export const SEARCH_RESULT_CEILING = 10_000;
/** Highest zero-indexed page reachable before the offset ceiling rejects the request. */
const MAX_SEARCH_PAGE = SEARCH_RESULT_CEILING / SEARCH_RESULTS_PER_PAGE - 1;

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
          ...ctx.recoveryFor('upstream_error'),
        });
      }

      return { status: response.status, text };
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw serviceUnavailable(
        `Network error reaching ProPublica API: ${err instanceof Error ? err.message : String(err)}`,
        { url, reason: 'upstream_error', ...ctx.recoveryFor('upstream_error') },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Search organizations by keyword and optional filters. */
  search(params: SearchParams, ctx: Context): Promise<RawSearchResponse> {
    return withRetry(
      async () => {
        const url = new URL(`${BASE_URL}/search.json`);
        if (params.query) url.searchParams.set('q', params.query);
        if (params.state) url.searchParams.set('state[id]', params.state);
        if (params.ntee_category) url.searchParams.set('ntee[id]', params.ntee_category);
        if (params.subsection_code) url.searchParams.set('c_code[id]', params.subsection_code);
        url.searchParams.set('page', String(params.page));

        ctx.log.debug('Searching nonprofits', { url: url.toString() });

        /**
         * ProPublica answers both a zero-match query and a page past `num_pages` with
         * HTTP 404, and a page at or beyond the result-offset ceiling with HTTP 400.
         * Tolerate both so the body — not the status — decides the classification:
         * `total_results` separates zero matches from an exhausted page, and only the
         * 400 shape is a hard boundary the caller must correct.
         */
        const { status, text } = await this.fetchTolerant(url.toString(), [400, 404], ctx);
        const data = this.parseJson<RawSearchResponse>(text, url.toString(), ctx);

        if (status === 400) {
          if (/pagination/i.test(data.error ?? '')) {
            throw validationError(
              `Page ${params.page} is at or beyond ProPublica's ${SEARCH_RESULT_CEILING.toLocaleString()}-result pagination ceiling. ` +
                `At ${SEARCH_RESULTS_PER_PAGE} results per page, pages 0–${MAX_SEARCH_PAGE} are reachable.`,
              {
                page: params.page,
                reason: 'pagination_ceiling',
                retryable: false,
                ...ctx.recoveryFor('pagination_ceiling'),
              },
            );
          }
          throw serviceUnavailable('ProPublica API rejected the search request.', {
            url: url.toString(),
            statusCode: status,
            reason: 'upstream_error',
            ...ctx.recoveryFor('upstream_error'),
          });
        }

        return data;
      },
      {
        operation: 'NonprofitExplorer.search',
        context: ctx,
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
    return withRetry(
      async () => {
        const url = `${BASE_URL}/organizations/${ein}.json`;
        ctx.log.debug('Fetching nonprofit org', { ein });

        // Tolerate 404 — the API returns HTTP 404 + a JSON body for "org not found". We
        // inspect the body before deciding how to classify the error, rather than letting
        // the network layer throw a generic FetchHttpError.
        const { status, text } = await this.fetchTolerant(url, [404], ctx);

        const data = this.parseJson<RawOrgResponse>(text, url, ctx);
        const org = data.organization;

        /**
         * Three upstream signatures all mean "no such EIN": HTTP 404 with an error body,
         * HTTP 200 with id 0, and HTTP 200 with an "Unknown Organization" placeholder record.
         */
        if (
          status === 404 ||
          !org ||
          org.id === 0 ||
          (org.name === 'Unknown Organization' && org.address === null)
        ) {
          throw notFound(`No organization found for EIN ${ein}.`, {
            ein,
            reason: 'not_found',
            ...ctx.recoveryFor('not_found'),
          });
        }

        return data;
      },
      {
        operation: 'NonprofitExplorer.getOrganization',
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /** Parse JSON from an upstream response; throws serviceUnavailable on HTML error pages. */
  private parseJson<T>(text: string, url: string, ctx: Context): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'ProPublica API returned HTML instead of JSON — likely a transient server error.',
        { url, reason: 'upstream_error', ...ctx.recoveryFor('upstream_error') },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw serviceUnavailable('ProPublica API returned unparseable response.', {
        url,
        reason: 'upstream_error',
        ...ctx.recoveryFor('upstream_error'),
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

/**
 * Postal codes ProPublica's `state[id]` filter recognizes: the 50 states, DC, the
 * territories and freely associated states, the military ZIP regions the IRS Business
 * Master File uses, and `ZZ` for foreign-address organizations.
 */
const US_POSTAL_CODES: ReadonlySet<string> = new Set(
  [
    // 50 states
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO',
    'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY',
    // District of Columbia, territories, and freely associated states
    'DC AS GU MP PR VI FM MH PW',
    // Armed Forces Americas / Europe / Pacific, and foreign-address organizations
    'AA AE AP ZZ',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Uppercase a state input and confirm ProPublica can honor it as a filter.
 * Returns null for anything outside the recognized postal codes — the API answers those
 * with HTTP 200 and the unfiltered national result set rather than an error.
 */
export function normalizeStateCode(state: string): string | null {
  const code = state.trim().toUpperCase();
  return US_POSTAL_CODES.has(code) ? code : null;
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
