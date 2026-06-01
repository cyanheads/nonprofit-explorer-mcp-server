/**
 * @fileoverview Search 1.8M+ tax-exempt organizations by name/keyword with optional filters.
 * @module mcp-server/tools/definitions/nonprofit-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNonprofitExplorerService } from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

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
        'Two-letter US state abbreviation (e.g., "WA", "NY"). Use "ZZ" for foreign entities. ' +
          'Restricts results to orgs headquartered in that state.',
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
    num_pages: z.number().describe('Total pages available (total_results / 25, ceiling).'),
    cur_page: z.number().describe('Current page (zero-indexed).'),
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

  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No organizations match the given query and filters',
      recovery: 'Broaden the keyword query, remove one or more filters, or check spelling.',
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
    ctx.log.info('Searching nonprofits', {
      query: input.query,
      state: input.state,
      ntee_category: input.ntee_category,
      subsection_code: input.subsection_code,
      page: input.page,
    });

    const svc = getNonprofitExplorerService();
    const raw = await svc.search(
      {
        query: input.query,
        state: input.state,
        ntee_category: input.ntee_category,
        subsection_code: input.subsection_code,
        page: input.page,
      },
      ctx,
    );

    const orgs = raw.organizations ?? [];
    const total = raw.total_results ?? 0;
    const numPages = raw.num_pages ?? 0;
    const curPage = raw.cur_page ?? input.page;

    if (orgs.length === 0) {
      throw ctx.fail(
        'no_results',
        `No organizations matched query="${input.query}" with the active filters.`,
        { ...ctx.recoveryFor('no_results') },
      );
    }

    return {
      total_results: total,
      num_pages: numPages,
      cur_page: curPage,
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
        state: input.state ?? null,
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
