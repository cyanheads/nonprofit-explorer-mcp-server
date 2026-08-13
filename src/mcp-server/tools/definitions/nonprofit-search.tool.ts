/**
 * @fileoverview Search 1.8M+ tax-exempt organizations by name/keyword with optional filters.
 * @module mcp-server/tools/definitions/nonprofit-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getNonprofitExplorerService,
  normalizeStateCode,
} from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

export const nonprofitSearch = tool('nonprofit_search', {
  title: 'Search Nonprofits',
  description:
    'Search 1.8M+ IRS-recognized tax-exempt organizations by name, keyword, city, or phrase. ' +
    'Optionally narrow by US state, NTEE major sector (1–10), or 501(c) subsection type. ' +
    'Returns EINs — pass them to nonprofit_get_organization or nonprofit_get_filings for details. ' +
    'Results are paginated at 25 per page; use the page parameter and num_pages to paginate. ' +
    'Total results cap at 10,000 in the API; if total_results === 10000 the actual count may be higher. ' +
    'Supports quoted phrases ("Red Cross"), required terms (+evanston), excluded terms (-dental). ' +
    'Data from ProPublica Nonprofit Explorer, sourced from IRS Form 990 filings.',
  annotations: { readOnlyHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Keyword search string. Searched against org name, alternate name, and city in order of relevance. ' +
          'Supports: quoted phrases ("Red Cross"), required terms (+evanston), excluded terms (-dental). ' +
          'Empty string returns all orgs within the active filters.',
      ),
    state: z
      .string()
      .length(2)
      .optional()
      .describe(
        'Two-letter US state, territory, or military postal code (e.g., "WA", "NY", "PR"). ' +
          'Case-insensitive — normalized to uppercase before filtering. ' +
          'A code outside that set is rejected rather than silently returning national results. ' +
          'Restricts results to orgs headquartered in that state. ' +
          '"ZZ" (foreign address) is accepted, but no organization in the index currently carries it.',
      ),
    ntee_category: z
      .enum(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
      .optional()
      .describe(
        'NTEE (National Taxonomy of Exempt Entities) major group integer (1–10). ' +
          '1=Arts/Culture/Humanities, 2=Education, 3=Environment/Animals, 4=Health, ' +
          '5=Human Services, 6=International/Foreign Affairs, 7=Public/Societal Benefit, ' +
          '8=Religion Related, 9=Mutual/Membership Benefit, 10=Unknown/Unclassified.',
      ),
    subsection_code: z
      .enum([
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
        '11',
        '12',
        '13',
        '14',
        '15',
        '16',
        '17',
        '18',
        '19',
        '21',
        '22',
        '23',
        '25',
        '26',
        '27',
        '28',
        '92',
      ])
      .optional()
      .describe(
        '501(c) subsection code. "3" = public charity (most common — donations tax-deductible), ' +
          '"4" = social welfare org, "6" = business league/trade association, ' +
          '"92" = 4947(a)(1) nonexempt charitable trust. Filters by tax status, not sector.',
      ),
    page: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-indexed page number. 25 results per page. Total pages is in num_pages. ' +
          'Increment to paginate large result sets.',
      ),
  }),

  output: z.object({
    total_results: z
      .number()
      .describe(
        'Total matching orgs (up to 10,000 — the API ceiling). If 10000, actual count may be higher.',
      ),
    num_pages: z
      .number()
      .describe(
        'Total pages available (total_results / 25, ceiling). The last valid page is num_pages - 1.',
      ),
    cur_page: z.number().describe('Current page (zero-indexed).'),
    per_page: z.number().describe('Results per page applied by the API (25).'),
    page_offset: z
      .number()
      .describe(
        'Zero-indexed offset of the first result on this page. Requests are refused once this reaches 10,000.',
      ),
    organizations: z
      .array(
        z
          .object({
            ein: z
              .number()
              .describe(
                'Employer Identification Number — use with nonprofit_get_organization and nonprofit_get_filings.',
              ),
            strein: z.string().describe('EIN in "XX-XXXXXXX" format (preserves leading zeros).'),
            name: z.string().describe('Legal org name per IRS.'),
            sub_name: z
              .string()
              .nullable()
              .describe('Alternate or subtitle name, or chapter identifier. Null when absent.'),
            city: z.string().nullable().describe('Headquarters city. Null when not on record.'),
            state: z
              .string()
              .nullable()
              .describe('Two-letter state abbreviation. Null when not on record.'),
            ntee_code: z
              .string()
              .nullable()
              .describe(
                'Full NTEE code (e.g., "E210" = hospital). More specific than the ntee_category filter.',
              ),
            subseccd: z
              .number()
              .nullable()
              .describe(
                '501(c) subsection code (e.g., 3 = public charity). Null when not classified.',
              ),
            score: z.number().describe('Relevance score — higher = better match.'),
          })
          .describe('A matched tax-exempt organization.'),
      )
      .describe('Matching organizations for the current page.'),
    active_filters: z
      .object({
        query: z.string().describe('Search query as submitted.'),
        state: z.string().nullable().describe('State filter applied, or null.'),
        ntee_category: z.string().nullable().describe('NTEE major group filter applied, or null.'),
        subsection_code: z
          .string()
          .nullable()
          .describe('501(c) subsection filter applied, or null.'),
      })
      .describe('Active filters echoed back for verification.'),
    data_source: z.string().describe('ProPublica + IRS attribution text.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the page carried no organizations — distinguishes a zero-match query from a page past the end of the result set, and names the next call.',
      ),
  },

  errors: [
    {
      reason: 'invalid_state',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The state filter is not a US state, territory, or military postal code (or ZZ for foreign entities)',
      recovery:
        'Pass a two-letter USPS code such as WA, NY, or PR; use ZZ for foreign-address organizations, or omit state to search nationally.',
    },
    {
      reason: 'pagination_ceiling',
      code: JsonRpcErrorCode.ValidationError,
      when: "The requested page is at or beyond ProPublica's 10,000-result offset ceiling",
      retryable: false,
      recovery:
        'Narrow the result set with the state, ntee_category, or subsection_code filters or a more specific query, then request a page below 400.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'ProPublica API returns a 500 or network error',
      retryable: true,
      recovery: "Wait a moment and retry. ProPublica's API is keyless and generally stable.",
    },
  ],

  async handler(input, ctx) {
    /**
     * ProPublica honors `state[id]` only on an exact match against a real postal code and
     * answers anything else with the unfiltered national result set at HTTP 200. Normalize
     * case, and reject what still can't be honored — a rejection the caller can act on beats
     * a plausible-looking national answer labelled as state-filtered.
     */
    let state: string | undefined;
    if (input.state !== undefined) {
      const normalized = normalizeStateCode(input.state);
      if (normalized === null) {
        throw ctx.fail(
          'invalid_state',
          `"${input.state}" is not a US state, territory, or military postal code. ` +
            'ProPublica ignores an unrecognized state filter and returns unfiltered national results.',
          { ...ctx.recoveryFor('invalid_state') },
        );
      }
      state = normalized;
    }

    ctx.log.info('Searching nonprofits', {
      query: input.query,
      state,
      ntee_category: input.ntee_category,
      subsection_code: input.subsection_code,
      page: input.page,
    });

    const svc = getNonprofitExplorerService();
    const raw = await svc.search({ ...input, state }, ctx);

    const orgs = raw.organizations ?? [];
    const total = raw.total_results ?? 0;
    const numPages = raw.num_pages ?? 0;
    const curPage = raw.cur_page ?? input.page;

    /**
     * An empty page has two causes the caller must handle differently, and `total_results`
     * — not the HTTP status — separates them: ProPublica returns 404 for both a zero-match
     * query and a page well past the end. Both are successful searches, so they return an
     * empty list plus one notice rather than an error. `ctx.enrich.notice` is last-wins, so
     * the two cases share a single call site.
     */
    if (orgs.length === 0) {
      ctx.enrich.notice(
        total === 0
          ? `No organizations matched query="${input.query}" with the active filters. ` +
              'Broaden the query, drop the state, ntee_category, or subsection_code filter, or check the spelling.'
          : `Page ${curPage} is past the end of this result set: ${total.toLocaleString()} matches span ` +
              `${numPages} pages, so the last page is ${numPages - 1}. Re-request with a page in 0–${numPages - 1}.`,
      );
    }

    return {
      total_results: total,
      num_pages: numPages,
      cur_page: curPage,
      per_page: raw.per_page ?? 0,
      page_offset: raw.page_offset ?? 0,
      organizations: orgs.map((o) => ({
        ein: o.ein,
        strein: o.strein ?? String(o.ein),
        name: o.name ?? '',
        sub_name: o.sub_name ?? null,
        city: o.city ?? null,
        state: o.state ?? null,
        ntee_code: o.ntee_code ?? null,
        subseccd: o.subseccd ?? null,
        score: o.score ?? 0,
      })),
      active_filters: {
        query: input.query,
        state: state ?? null,
        ntee_category: input.ntee_category ?? null,
        subsection_code: input.subsection_code ?? null,
      },
      data_source: raw.data_source ?? 'ProPublica Nonprofit Explorer, IRS Form 990 data.',
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(
      `**Found:** ${result.total_results.toLocaleString()} total org${result.total_results !== 1 ? 's' : ''} ` +
        `| Page ${result.cur_page} of ${result.num_pages} total pages` +
        (result.total_results === 10000 ? ' — API cap reached; actual count may be higher' : ''),
    );
    lines.push(
      `**Page window:** ${result.per_page} per page, starting at result offset ${result.page_offset}`,
    );

    lines.push(`**Query:** ${result.active_filters.query}`);
    const filters: string[] = [];
    if (result.active_filters.state) filters.push(`state=${result.active_filters.state}`);
    if (result.active_filters.ntee_category)
      filters.push(`ntee=${result.active_filters.ntee_category}`);
    if (result.active_filters.subsection_code)
      filters.push(`501(c)=${result.active_filters.subsection_code}`);
    if (filters.length > 0) lines.push(`**Filters:** ${filters.join(', ')}`);

    lines.push('');

    for (const org of result.organizations) {
      lines.push(`## ${org.name}`);
      lines.push(`**EIN (int):** ${org.ein} | **EIN:** ${org.strein} | **Score:** ${org.score}`);
      const loc = [org.city, org.state].filter(Boolean).join(', ');
      if (loc) lines.push(`**Location:** ${loc}`);
      if (org.ntee_code) lines.push(`**NTEE Code:** ${org.ntee_code}`);
      if (org.subseccd != null) lines.push(`**501(c):** 501(c)(${org.subseccd})`);
      if (org.sub_name) lines.push(`**Alternate Name:** ${org.sub_name}`);
      lines.push('');
    }

    lines.push(`*${result.data_source}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
