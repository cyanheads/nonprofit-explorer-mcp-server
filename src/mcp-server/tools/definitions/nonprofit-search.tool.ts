/**
 * @fileoverview Search 1.8M+ tax-exempt organizations by name/keyword with optional filters.
 * @module mcp-server/tools/definitions/nonprofit-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getNonprofitExplorerService,
  normalizeStateCode,
  SEARCH_RESULT_CEILING,
} from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

/** Pluralize a count so a single-page result set does not read as "1 pages". */
const plural = (n: number, word: string, pluralForm = `${word}s`) =>
  `${n.toLocaleString()} ${n === 1 ? word : pluralForm}`;

/** A filter the caller did not supply — distinct from a value the record lacks. */
const NOT_APPLIED = 'Not applied';
/** A value the IRS Business Master File does not carry for this organization. */
const NOT_ON_RECORD = 'Not on record';
/** No IRS classification code on record for this organization. */
const NOT_CLASSIFIED = 'Not classified';

export const nonprofitSearch = tool('nonprofit_search', {
  title: 'Search Nonprofits',
  description:
    'Search 1.8M+ IRS-recognized tax-exempt organizations by name, keyword, city, or phrase. ' +
    'Optionally narrow by US state, NTEE major sector (1–10), or 501(c) subsection type. ' +
    'Returns EINs — pass them to nonprofit_get_organization or nonprofit_get_filings for details. ' +
    'Results are paginated at 25 per page; use the page parameter and num_pages to paginate. ' +
    'Total results cap at 10,000 in the API; if total_results === 10000 the actual count may be higher. ' +
    'A zero-match query and a page past the last one both return an empty organizations array with a notice rather than an error; only a page whose offset reaches that 10,000 cap is refused. ' +
    'Supports quoted phrases ("Red Cross"), required terms (+evanston), excluded terms (-dental). ' +
    'Data from ProPublica Nonprofit Explorer, sourced from IRS Form 990 filings.',
  annotations: { readOnlyHint: true },

  input: z.object({
    query: z
      .string()
      .describe(
        'Keyword search string. Searched against org name, the secondary name line, and city in order of relevance. ' +
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
        '501(c) subsection code. "3" = charitable/religious/educational organization (most common — includes both public charities and private foundations; nonprofit_get_organization returns foundation_type to tell them apart), ' +
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
              .describe(
                'The legal name with the IRS Business Master File secondary name line appended — a division, service-center, or chapter identifier, not a separate trade name the org operates under. Null when the org has no secondary name line.',
              ),
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
                '501(c) subsection code (e.g., 3 = charitable organization). Null when not classified.',
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
        'Present when the response needs a caveat the domain fields cannot carry: a page that returned no organizations (distinguishing a zero-match query from a page past the end of the result set, and naming the next call), a total_results sitting on the API result ceiling rather than counting matches, or both at once in one string. Absent when the page is populated and the total is an exact count.',
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
     * Three conditions can need a caveat, and they co-occur: an empty page has two
     * causes the caller must handle differently — `total_results`, not the HTTP status,
     * separates a zero-match query from a page past the end, since ProPublica answers
     * both with 404 — and either can land on a `total_results` that is the API's result
     * ceiling rather than a count. All are successful searches. `ctx.enrich.notice` is
     * last-wins, so the segments compose into one string emitted by one call; a second
     * call would silently drop everything before it.
     */
    const lastPage = numPages - 1;
    const segments: string[] = [];

    if (orgs.length === 0) {
      segments.push(
        total === 0
          ? `No organizations matched query="${input.query}" with the active filters. ` +
              'Broaden the query, drop the state, ntee_category, or subsection_code filter, or check the spelling.'
          : `Page ${curPage} is past the end of this result set: ${plural(total, 'match', 'matches')} span ` +
              `${plural(numPages, 'page')}, so the last page is ${lastPage}. ` +
              (numPages === 1
                ? 'Re-request with page 0.'
                : `Re-request with a page in 0–${lastPage}.`),
      );
    }

    if (total === SEARCH_RESULT_CEILING) {
      segments.push(
        `total_results is ProPublica's ${SEARCH_RESULT_CEILING.toLocaleString()}-result ceiling, not a count of matches — ` +
          'at least this many match, the true number is unknowable from this API, and pages past the ceiling are refused. ' +
          'Narrow with the state, ntee_category, or subsection_code filter for a countable result set.',
      );
    }

    if (segments.length > 0) ctx.enrich.notice(segments.join(' '));

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

    /**
     * The result-cap caveat rides the enrichment notice, which reaches this text as a
     * trailer — repeating it here would show it twice. The past-the-end marker does not
     * duplicate anything: without it, "Page 245 of 245 pages" reads as a contradiction
     * to a client working down content[] before it reaches the trailer.
     */
    const lastPage = result.num_pages - 1;
    const pastEnd = result.num_pages > 0 && result.cur_page > lastPage;
    lines.push(
      `**Found:** ${result.total_results.toLocaleString()} total org${result.total_results === 1 ? '' : 's'} ` +
        `| Page ${result.cur_page} of ${plural(result.num_pages, 'page')}` +
        (pastEnd ? ` — past the end; the last page is ${lastPage}` : ''),
    );
    lines.push(
      `**Page window:** ${result.per_page} per page, starting at result offset ${result.page_offset}`,
    );

    /**
     * Every nullable field renders, null included. Dropping one leaves a `content[]`-only
     * client unable to tell an unapplied filter or an unclassified org from a field the
     * response never carried — and the labels stay distinct per field, since "not applied"
     * and "not on record" are different facts.
     */
    lines.push(`**Query:** ${result.active_filters.query}`);
    lines.push(
      `**Filters:** state=${result.active_filters.state ?? NOT_APPLIED}, ` +
        `ntee=${result.active_filters.ntee_category ?? NOT_APPLIED}, ` +
        `501(c)=${result.active_filters.subsection_code ?? NOT_APPLIED}`,
    );

    lines.push('');

    for (const org of result.organizations) {
      lines.push(`## ${org.name}`);
      lines.push(`**EIN (int):** ${org.ein} | **EIN:** ${org.strein} | **Score:** ${org.score}`);
      lines.push(
        `**City:** ${org.city ?? NOT_ON_RECORD} | **State:** ${org.state ?? NOT_ON_RECORD}`,
      );
      lines.push(`**NTEE Code:** ${org.ntee_code ?? NOT_CLASSIFIED}`);
      lines.push(
        `**501(c):** ${org.subseccd != null ? `501(c)(${org.subseccd})` : NOT_CLASSIFIED}`,
      );
      lines.push(`**Name with Secondary Line:** ${org.sub_name ?? NOT_ON_RECORD}`);
      lines.push('');
    }

    lines.push(`*${result.data_source}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
