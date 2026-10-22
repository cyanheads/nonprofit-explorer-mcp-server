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
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import type { RawOrgResponse, RawSearchResponse, SearchParams } from './types.js';

const BASE_URL = 'https://projects.propublica.org/nonprofits/api/v2';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER = 0.25;
/** Retain the existing four-attempt envelope, including maximum jittered backoffs. */
const REQUEST_DEADLINE_MS =
  FETCH_TIMEOUT_MS * (MAX_RETRIES + 1) +
  RETRY_BASE_DELAY_MS * (2 ** MAX_RETRIES - 1) * (1 + RETRY_JITTER);

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
   * Read a response within the attempt timeout, tolerating the caller's named statuses.
   * Caller cancellation propagates unchanged; attempt expiry throws Timeout, while
   * network failures and unexpected statuses throw ServiceUnavailable.
   */
  private async fetchTolerant(
    url: string,
    toleratedStatuses: number[],
    signal: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timeoutReason = new DOMException('ProPublica request timed out.', 'TimeoutError');
    const timeoutId = setTimeout(() => controller.abort(timeoutReason), FETCH_TIMEOUT_MS);
    const forwardAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', forwardAbort, { once: true });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      const text = await response.text();
      signal.throwIfAborted();
      controller.signal.throwIfAborted();

      // Non-2xx that isn't in the tolerated list is a service error
      if (!response.ok && !toleratedStatuses.includes(response.status)) {
        throw serviceUnavailable(`ProPublica API returned unexpected status ${response.status}.`, {
          statusCode: response.status,
          reason: 'upstream_error',
        });
      }

      return { status: response.status, text };
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (controller.signal.reason === timeoutReason) {
        throw timeout('ProPublica API request timed out.', { reason: 'timeout' }, { cause: err });
      }
      if (err instanceof McpError) throw err;
      throw serviceUnavailable(
        'Network error reaching ProPublica API.',
        { reason: 'upstream_error' },
        { cause: err },
      );
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  /** Search organizations by keyword and optional filters. */
  search(params: SearchParams, ctx: Context): Promise<RawSearchResponse> {
    return withRetry(
      async ({ signal }) => {
        const url = new URL(`${BASE_URL}/search.json`);
        if (params.query) url.searchParams.set('q', params.query);
        if (params.state) url.searchParams.set('state[id]', params.state);
        if (params.ntee_category) url.searchParams.set('ntee[id]', params.ntee_category);
        if (params.subsection_code) url.searchParams.set('c_code[id]', params.subsection_code);
        url.searchParams.set('page', String(params.page));

        ctx.log.debug('Searching nonprofits', { page: params.page });

        /**
         * ProPublica answers both a zero-match query and a page past `num_pages` with
         * HTTP 404, and a page at or beyond the result-offset ceiling with HTTP 400.
         * Tolerate both so the body — not the status — decides the classification:
         * `total_results` separates zero matches from an exhausted page, and only the
         * 400 shape is a hard boundary the caller must correct.
         */
        const { status, text } = await this.fetchTolerant(url.toString(), [400, 404], signal);
        const data = this.parseJson<RawSearchResponse>(text);

        if (status === 400) {
          if (/pagination/i.test(data.error ?? '')) {
            throw validationError(
              `Page ${params.page} is at or beyond ProPublica's ${SEARCH_RESULT_CEILING.toLocaleString()}-result pagination ceiling. ` +
                `At ${SEARCH_RESULTS_PER_PAGE} results per page, pages 0–${MAX_SEARCH_PAGE} are reachable.`,
              { page: params.page, reason: 'pagination_ceiling', retryable: false },
            );
          }
          throw serviceUnavailable('ProPublica API rejected the search request.', {
            statusCode: status,
            reason: 'upstream_error',
          });
        }

        return data;
      },
      {
        operation: 'NonprofitExplorer.search',
        context: ctx,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxRetries: MAX_RETRIES,
        jitter: RETRY_JITTER,
        signal: ctx.signal,
        deadlineMs: REQUEST_DEADLINE_MS,
      },
    );
  }

  /**
   * Fetch full organization profile and all filings by EIN.
   * Handles the three not-found signatures and throws notFound when detected.
   */
  getOrganization(ein: number, ctx: Context): Promise<RawOrgResponse> {
    return withRetry(
      async ({ signal }) => {
        const url = `${BASE_URL}/organizations/${ein}.json`;
        ctx.log.debug('Fetching nonprofit org', { ein });

        // Tolerate 404 — the API returns HTTP 404 + a JSON body for "org not found". We
        // inspect the body before deciding how to classify the error, rather than letting
        // the network layer throw a generic FetchHttpError.
        const { status, text } = await this.fetchTolerant(url, [404], signal);

        const data = this.parseJson<RawOrgResponse>(text);
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
          throw notFound(`No organization found for EIN ${ein}.`, { ein, reason: 'not_found' });
        }

        return data;
      },
      {
        operation: 'NonprofitExplorer.getOrganization',
        context: ctx,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxRetries: MAX_RETRIES,
        jitter: RETRY_JITTER,
        signal: ctx.signal,
        deadlineMs: REQUEST_DEADLINE_MS,
      },
    );
  }

  /** Parse JSON from an upstream response; throws serviceUnavailable on HTML error pages. */
  private parseJson<T>(text: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'ProPublica API returned HTML instead of JSON — likely a transient server error.',
        { reason: 'upstream_error' },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw serviceUnavailable('ProPublica API returned unparseable response.', {
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
