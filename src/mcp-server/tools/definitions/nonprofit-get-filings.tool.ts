/**
 * @fileoverview All Form 990 filings for an org with financials, executive compensation, and PDF links.
 * @module mcp-server/tools/definitions/nonprofit-get-filings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { compareTaxPeriods } from '@/services/nonprofit-explorer/filing-history.js';
import { emptyHistoryNotice } from '@/services/nonprofit-explorer/filing-requirements.js';
import {
  getNonprofitExplorerService,
  normalizeEin,
} from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';
import type { RawFiling } from '@/services/nonprofit-explorer/types.js';

const USD = (n: number) => `$${n.toLocaleString()}`;
const PCT = (n: number) => `${(n * 100).toFixed(1)}%`;

/** A figure ProPublica did not extract from this filing. */
const NOT_EXTRACTED = 'Not extracted';
/** A figure the organization left blank on the filing. */
const NOT_REPORTED = 'Not reported';
/** A figure no field in the response can produce. */
const NOT_DERIVABLE = 'Not derivable from this data source';

/** A line item that does not exist on the given form type at all. */
const notApplicableFor = (formType: string) => `Not applicable for ${formType}`;

/** Render a nullable USD amount, naming why it is absent rather than omitting the line. */
const money = (n: number | null, absent: string = NOT_EXTRACTED) => (n == null ? absent : USD(n));

/** Map formtype integer to form label. */
function formTypeLabel(ft: number | undefined): '990' | '990-EZ' | '990-PF' {
  if (ft === 1) return '990-EZ';
  if (ft === 2) return '990-PF';
  return '990';
}

/**
 * Build the executive-compensation summary. The form type picks the source field;
 * `amount` is null when the extract omits it.
 */
function buildExecComp(filing: RawFiling): {
  amount: number | null;
  field_name: 'compnsatncurrofcr' | 'compofficers' | null;
  form_type: '990' | '990-EZ' | '990-PF';
  note: string;
} {
  if (filing.formtype === 2) {
    // 990-PF: compofficers (may be null/absent in the extract)
    return {
      amount: filing.compofficers ?? null,
      field_name: 'compofficers',
      form_type: '990-PF',
      note: '990-PF: compensation of officers, directors, trustees.',
    };
  }

  if (filing.formtype === 1) {
    return {
      amount: null,
      field_name: null,
      form_type: '990-EZ',
      note: '990-EZ officer compensation is not extracted by this data source. Read Part IV of the source PDF for officer detail.',
    };
  }

  // Form 990: compnsatncurrofcr
  return {
    amount: filing.compnsatncurrofcr ?? null,
    field_name: 'compnsatncurrofcr',
    form_type: formTypeLabel(filing.formtype),
    note: '990: total compensation of current officers, directors, trustees, and key employees. Per-officer breakdown requires Schedule J in the source PDF.',
  };
}

export const nonprofitGetFilings = tool('nonprofit_get_filings', {
  title: 'Get Nonprofit Filings',
  description:
    'Form 990 history by EIN with extracted financials, form-specific compensation, and PDF-only returns. Optional inclusive from_year/to_year bounds select fiscal years across both histories; omitted bounds return full history. Unfiltered totals remain available. Records are sorted by full tax period without amendment precedence. Empty dataset history succeeds with BMF context; an empty selected window does not imply no history. Data lags 1–2 years; always cite tax_prd_yr. Data from ProPublica Nonprofit Explorer and IRS Form 990 filings.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    ein: z
      .union([
        z
          .number()
          .int()
          .positive()
          .describe(
            'EIN as integer (e.g., 530196605). Leading zeros are stripped — treat EIN as an integer key.',
          ),
        z
          .string()
          .regex(/^\d{2}-?\d{7}$/)
          .describe('EIN as string, with or without hyphen (e.g., "53-0196605" or "530196605").'),
      ])
      .describe(
        'Employer Identification Number. Use nonprofit_search_organizations to resolve an org name to its EIN.',
      ),
    from_year: z
      .number()
      .int()
      .optional()
      .describe('Inclusive minimum fiscal year (tax_prd_yr). Omit for no lower bound.'),
    to_year: z
      .number()
      .int()
      .optional()
      .describe('Inclusive maximum fiscal year (tax_prd_yr). Omit for no upper bound.'),
  }),

  output: z.object({
    ein: z.number().describe('Employer Identification Number as integer.'),
    name: z.string().describe('Legal org name per IRS.'),
    from_year: z
      .number()
      .int()
      .nullable()
      .describe('Applied inclusive lower fiscal-year bound. Null when omitted.'),
    to_year: z
      .number()
      .int()
      .nullable()
      .describe('Applied inclusive upper fiscal-year bound. Null when omitted.'),
    filings: z
      .array(
        z
          .object({
            tax_prd_yr: z
              .number()
              .describe(
                'Fiscal year of this filing (e.g., 2023). NOT the filing date — data lags 1–2 years. Always cite.',
              ),
            tax_prd: z
              .number()
              .describe(
                'YYYYMM month the fiscal year ended (e.g., 202306 = June 2023 fiscal year end).',
              ),
            form_type: z.enum(['990', '990-EZ', '990-PF']).describe('IRS form type filed.'),
            pdf_url: z
              .string()
              .nullable()
              .describe(
                'Source Form 990 PDF link. Null for some IRS processing batches — check filings_pdf_only.',
              ),
            updated: z
              .string()
              .nullable()
              .describe(
                'ISO datetime ProPublica last updated this record. Null when not provided.',
              ),
            total_revenue: z
              .number()
              .nullable()
              .describe('Total revenue in USD. Null when not extracted.'),
            total_expenses: z
              .number()
              .nullable()
              .describe('Total expenses in USD. Null when not extracted.'),
            total_assets: z
              .number()
              .nullable()
              .describe('Total assets (end of year) in USD. Null when not extracted.'),
            total_liabilities: z
              .number()
              .nullable()
              .describe('Total liabilities (end of year) in USD. Null when not extracted.'),
            net_assets: z
              .number()
              .nullable()
              .describe(
                'Net assets/fund balances (end of year) in USD. From totnetassetend (990), totnetassetsend (990-EZ), or tfundnworth (990-PF). Null when not extracted.',
              ),
            contributions_and_grants: z
              .number()
              .nullable()
              .describe(
                'Contributions and grants in USD: totcntrbgfts (990), totcntrbs (990-EZ), or grscontrgifts (990-PF). Null when not extracted.',
              ),
            program_service_revenue: z
              .number()
              .nullable()
              .describe(
                'Program service revenue in USD: totprgmrevnue (990) or prgmservrev (990-EZ). Not applicable for 990-PF.',
              ),
            investment_income: z
              .number()
              .nullable()
              .describe(
                'Investment income in USD: invstmntinc (990), othrinvstinc (990-EZ), or intrstrvnue plus dividndsamt (990-PF Part I column (a), lines 3–4: savings interest plus dividends and securities interest; excludes capital gains, rents, and net investment income). PF requires both components; null when not extracted.',
              ),
            other_salaries_and_wages: z
              .number()
              .nullable()
              .describe(
                '990 Part IX line 7A, othrsalwages, USD. Null when unextracted or inapplicable to EZ/PF.',
              ),
            payroll_taxes: z
              .number()
              .nullable()
              .describe(
                '990 Part IX line 10A, payrolltx, USD. Null when unextracted or inapplicable to EZ/PF.',
              ),
            professional_fundraising_fees: z
              .number()
              .nullable()
              .describe(
                '990 Part IX line 11eA, profndraising, USD. Null when unextracted or inapplicable to EZ/PF.',
              ),
            fundraising_events_gross: z
              .number()
              .nullable()
              .describe(
                'Event gross income excluding separately reported contributions: 990 VIII 8a grsincfndrsng or EZ I 6b grsrevnuefndrsng, USD. Null when unextracted or inapplicable to PF.',
              ),
            fundraising_events_direct_expenses: z
              .number()
              .nullable()
              .describe(
                '990 VIII 8b lessdirfndrsng, USD. Null when unextracted or inapplicable to EZ/PF; EZ combines gaming and events separately.',
              ),
            fundraising_events_net: z
              .number()
              .nullable()
              .describe(
                '990 VIII 8c netincfndrsng, USD; may be negative. Null when unextracted or inapplicable to EZ/PF.',
              ),
            gaming_and_fundraising_direct_expenses: z
              .number()
              .nullable()
              .describe(
                'EZ I 6c direxpns, USD, combined gaming and fundraising expenses. Null when unextracted or inapplicable to 990/PF.',
              ),
            gaming_and_fundraising_net: z
              .number()
              .nullable()
              .describe(
                'EZ I 6d netincfndrsng, USD, combined gaming and fundraising net. Null when unextracted or inapplicable to 990/PF.',
              ),
            grants_paid: z
              .number()
              .nullable()
              .describe(
                '990-PF contributions, gifts, and grants paid in USD, Part I line 25 column (a), contrpdpbks. Null for other forms or when not extracted.',
              ),
            distributable_amount: z
              .number()
              .nullable()
              .describe(
                '990-PF required distributable amount in USD, Part X line 7, distribamt. A payout requirement, not actual payments or a compliance measure. Null for other forms or when not extracted.',
              ),
            fair_market_value_assets: z
              .number()
              .nullable()
              .describe(
                '990-PF end-of-year fair-market-value assets in USD, header Item I, fairmrktvalamt. Null for other forms or when not extracted.',
              ),
            net_investment_income: z
              .number()
              .nullable()
              .describe(
                '990-PF net investment income in USD, Part I line 27b, netinvstinc. Null for other forms or when not extracted.',
              ),
            program_expense_ratio: z
              .object({
                ratio: z
                  .number()
                  .nullable()
                  .describe(
                    'Program-service expenses divided by total functional expenses, as a decimal 0.0–1.0. Always null against the current data source, which reports no program-service expense total.',
                  ),
                program_expenses: z
                  .number()
                  .nullable()
                  .describe(
                    'Program-service expenses in USD — Form 990 Part IX column (B), line 25.',
                  ),
                total_expenses: z
                  .number()
                  .nullable()
                  .describe(
                    'Total functional expenses in USD — Form 990 Part IX column (A). From totfuncexpns.',
                  ),
                management_compensation: z
                  .number()
                  .nullable()
                  .describe(
                    'Officer/director/trustee compensation (compnsatncurrofcr) in USD. Null when not reported.',
                  ),
                other_salaries: z
                  .number()
                  .nullable()
                  .describe(
                    'Other salaries and wages (othrsalwages) in USD. Null when not reported.',
                  ),
                fundraising_expenses: z
                  .number()
                  .nullable()
                  .describe(
                    'Professional fundraising fees (profndraising) in USD. Null when not reported.',
                  ),
                note: z
                  .string()
                  .describe('Methodology note naming the source of the functional allocation.'),
              })
              .nullable()
              .describe(
                'Always null against the current data source. ProPublica returns no Form 990 Part IX column (B) program-service expense total, and the functional allocation across program, management, and fundraising cannot be reconstructed from the fields it does return. Read Part IX of the filing at pdf_url for the split.',
              ),
            executive_compensation: z
              .object({
                amount: z
                  .number()
                  .nullable()
                  .describe(
                    'Total executive compensation in USD. Null when absent on supported 990/PF forms; always null on 990-EZ because the source does not extract it.',
                  ),
                field_name: z
                  .enum(['compnsatncurrofcr', 'compofficers'])
                  .nullable()
                  .describe(
                    'Source API field: compnsatncurrofcr on 990, compofficers on 990-PF. Null on 990-EZ, which has no extracted officer-compensation field.',
                  ),
                form_type: z
                  .enum(['990', '990-EZ', '990-PF'])
                  .describe('Form type this compensation field is sourced from.'),
                note: z
                  .string()
                  .describe(
                    'Plain-English description of what this field covers and where to find per-officer detail.',
                  ),
              })
              .describe(
                'Executive compensation summary. 990-EZ is unextracted; see Part IV of its PDF. Supported-form missing amounts remain null.',
              ),
          })
          .describe('Form 990 filing with extracted financial data for one fiscal year.'),
      )
      .describe('Filings with extracted financial data, sorted newest first.'),
    filings_pdf_only: z
      .array(
        z
          .object({
            tax_prd_yr: z.number().describe('Fiscal year of this filing.'),
            tax_prd: z
              .number()
              .nullable()
              .describe('YYYYMM tax period. Null when absent from the PDF-only record.'),
            form_type_str: z
              .string()
              .describe('Form type string as returned by API ("990", "990EZ", "990PF").'),
            pdf_url: z
              .string()
              .nullable()
              .describe('Source Form 990 PDF link. Null for some batches.'),
          })
          .describe(
            'Return with a PDF link but no extracted financial data; may be newer than extracted history.',
          ),
      )
      .describe('PDF-only returns sorted by full tax period, retaining equal-period entries.'),
    total_filings_with_data: z
      .number()
      .describe('Unfiltered count of filings with extracted financial data.'),
    total_filings_pdf_only: z
      .number()
      .describe('Unfiltered count of PDF-only filings (no extracted data).'),
    data_source: z.string().describe('ProPublica + IRS attribution text.'),
    propublica_url: z.string().describe('ProPublica Nonprofit Explorer URL for this org.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present only when the complete dataset history is empty, with BMF context and no inferred cause. A selected window can be empty while unfiltered totals show existing history.',
      ),
  },

  enrichmentTrailer: {
    notice: {
      render: (notice) => (notice === undefined ? '' : `> ${escapeMarkdownInline(notice)}`),
    },
  },

  errors: [
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'from_year is greater than to_year',
      recovery: 'Set from_year less than or equal to to_year, or omit either bound.',
    },
    {
      reason: 'timeout',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: 'A ProPublica API attempt expires before its response body finishes',
      retryable: true,
      recovery: 'Wait a moment and retry the request.',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      thrownBy: 'service',
      when: 'The complete ProPublica API retry exchange exceeds its deadline',
      retryable: true,
      recovery: 'Wait a moment and retry the request.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'The EIN does not correspond to a known organization in the Nonprofit Explorer database',
      recovery:
        'Verify the EIN with nonprofit_search_organizations. Use the integer EIN value (leading zeros stripped).',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      when: 'ProPublica API returns a non-JSON body or network error',
      retryable: true,
      recovery: 'Wait a moment and retry.',
    },
  ],

  async handler(input, ctx) {
    if (input.from_year != null && input.to_year != null && input.from_year > input.to_year)
      throw ctx.fail('invalid_year_range');
    const ein = normalizeEin(input.ein);
    ctx.log.info('Fetching nonprofit filings', { ein });

    const svc = getNonprofitExplorerService();

    const raw = await svc.getOrganization(ein, ctx);

    // Service validates organization presence and throws notFound before returning — safe to assert.
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by service not-found checks
    const org = raw.organization!;
    const filingsWithData = raw.filings_with_data ?? [];
    const filingsWithoutData = raw.filings_without_data ?? [];

    if (filingsWithData.length === 0 && filingsWithoutData.length === 0) {
      ctx.enrich.notice(emptyHistoryNotice(org, ein));
    }

    const inWindow = (f: { tax_prd_yr?: number }) =>
      (input.from_year == null || (f.tax_prd_yr != null && f.tax_prd_yr >= input.from_year)) &&
      (input.to_year == null || (f.tax_prd_yr != null && f.tax_prd_yr <= input.to_year));
    const sortedFilings = filingsWithData.filter(inWindow).sort(compareTaxPeriods);

    const mappedFilings = sortedFilings.map((f) => ({
      tax_prd_yr: f.tax_prd_yr ?? 0,
      tax_prd: f.tax_prd ?? 0,
      form_type: formTypeLabel(f.formtype),
      pdf_url: f.pdf_url ?? null,
      updated: f.updated ?? null,
      total_revenue: f.totrevenue ?? null,
      total_expenses: f.totfuncexpns ?? null,
      total_assets: f.totassetsend ?? null,
      total_liabilities: f.totliabend ?? null,
      net_assets:
        (f.formtype === 2
          ? f.tfundnworth
          : f.formtype === 1
            ? f.totnetassetsend
            : f.totnetassetend) ?? null,
      contributions_and_grants:
        (f.formtype === 2 ? f.grscontrgifts : f.formtype === 1 ? f.totcntrbs : f.totcntrbgfts) ??
        null,
      program_service_revenue:
        (f.formtype === 2 ? null : f.formtype === 1 ? f.prgmservrev : f.totprgmrevnue) ?? null,
      investment_income:
        f.formtype === 2
          ? f.intrstrvnue != null && f.dividndsamt != null
            ? f.intrstrvnue + f.dividndsamt
            : null
          : ((f.formtype === 1 ? f.othrinvstinc : f.invstmntinc) ?? null),
      grants_paid: f.formtype === 2 ? (f.contrpdpbks ?? null) : null,
      distributable_amount: f.formtype === 2 ? (f.distribamt ?? null) : null,
      fair_market_value_assets: f.formtype === 2 ? (f.fairmrktvalamt ?? null) : null,
      net_investment_income: f.formtype === 2 ? (f.netinvstinc ?? null) : null,
      other_salaries_and_wages:
        f.formtype === 1 || f.formtype === 2 ? null : (f.othrsalwages ?? null),
      payroll_taxes: f.formtype === 1 || f.formtype === 2 ? null : (f.payrolltx ?? null),
      professional_fundraising_fees:
        f.formtype === 1 || f.formtype === 2 ? null : (f.profndraising ?? null),
      fundraising_events_gross:
        f.formtype === 2
          ? null
          : ((f.formtype === 1 ? f.grsrevnuefndrsng : f.grsincfndrsng) ?? null),
      fundraising_events_direct_expenses:
        f.formtype === 1 || f.formtype === 2 ? null : (f.lessdirfndrsng ?? null),
      fundraising_events_net:
        f.formtype === 1 || f.formtype === 2 ? null : (f.netincfndrsng ?? null),
      gaming_and_fundraising_direct_expenses: f.formtype === 1 ? (f.direxpns ?? null) : null,
      gaming_and_fundraising_net: f.formtype === 1 ? (f.netincfndrsng ?? null) : null,
      /**
       * Not derived. `totfuncexpns` is Form 990 Part IX column (A); the program-service
       * total is column (B), which ProPublica does not return, and Part IX allocates
       * every expense line across program, management, and fundraising — not just
       * `compnsatncurrofcr`, `othrsalwages`, and `profndraising`.
       */
      program_expense_ratio: null,
      executive_compensation: buildExecComp(f),
    }));

    const mappedPdfOnly = filingsWithoutData
      .filter(inWindow)
      .sort(compareTaxPeriods)
      .map((f) => ({
        tax_prd_yr: f.tax_prd_yr ?? 0,
        tax_prd: f.tax_prd ?? null,
        form_type_str: f.formtype_str ?? '',
        pdf_url: f.pdf_url ?? null,
      }));

    const einNum = org.ein ?? ein;

    return {
      ein: einNum,
      name: org.name ?? '',
      from_year: input.from_year ?? null,
      to_year: input.to_year ?? null,
      filings: mappedFilings,
      filings_pdf_only: mappedPdfOnly,
      total_filings_with_data: filingsWithData.length,
      total_filings_pdf_only: filingsWithoutData.length,
      data_source: raw.data_source ?? 'ProPublica Nonprofit Explorer, IRS Form 990 data.',
      propublica_url: `https://projects.propublica.org/nonprofits/organizations/${einNum}`,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`# ${escapeMarkdownInline(result.name)} — Form 990 Filings`);
    lines.push(`**EIN:** ${result.ein}`);
    lines.push(
      `**Unfiltered filings with data:** ${result.total_filings_with_data} | ` +
        `**Unfiltered PDF-only filings:** ${result.total_filings_pdf_only}`,
    );
    lines.push(`**Profile:** ${markdownLink(result.propublica_url, result.propublica_url)}`);
    lines.push(
      `**Fiscal-year bounds (inclusive):** from_year=${result.from_year ?? 'null (unbounded)'}; to_year=${result.to_year ?? 'null (unbounded)'}`,
    );
    lines.push('');
    lines.push(
      '> ⚠️ Data lags 1–2 years. FY shown is the fiscal year, not the current year. Always cite the year.',
    );

    if (result.filings.length === 0) {
      lines.push('');
      lines.push(
        result.from_year != null || result.to_year != null
          ? '*No extracted filings in the selected fiscal-year window; unfiltered totals above describe the complete history.*'
          : '*No Form 990 with extracted financial data on record for this organization.*',
      );
    }

    for (const f of result.filings) {
      lines.push('');
      lines.push(`## FY ${f.tax_prd_yr} — ${f.form_type} (period: ${f.tax_prd})`);

      lines.push(
        `**Source 990 PDF:** ${f.pdf_url ? markdownLink(f.pdf_url, f.pdf_url) : 'Not yet available for this period'}`,
      );
      lines.push(`**Last updated:** ${escapeMarkdownInline(f.updated ?? 'Not provided')}`);

      lines.push('');
      lines.push('### Financials');
      lines.push(`**Revenue:** ${money(f.total_revenue)}`);
      lines.push(`**Expenses:** ${money(f.total_expenses)}`);
      lines.push(`**Assets (EoY):** ${money(f.total_assets)}`);
      lines.push(`**Liabilities (EoY):** ${money(f.total_liabilities)}`);
      lines.push(`**Net Assets (EoY):** ${money(f.net_assets)}`);

      /** Program-service revenue has no corresponding 990-PF line item. */
      const programRevenueAbsent =
        f.form_type === '990-PF' ? notApplicableFor(f.form_type) : NOT_EXTRACTED;
      lines.push('');
      lines.push('### Revenue Breakdown');
      lines.push(`**Contributions & Grants:** ${money(f.contributions_and_grants)}`);
      lines.push(
        `**Program Service Revenue:** ${money(f.program_service_revenue, programRevenueAbsent)}`,
      );
      lines.push(`**Investment Income:** ${money(f.investment_income)}`);
      const pfAbsent = f.form_type === '990-PF' ? NOT_EXTRACTED : notApplicableFor(f.form_type);
      lines.push('');
      lines.push('### 990-PF Foundation Financials');
      if (
        f.form_type !== '990-PF' &&
        f.grants_paid == null &&
        f.distributable_amount == null &&
        f.fair_market_value_assets == null &&
        f.net_investment_income == null
      ) {
        lines.push(
          `**Grants Paid; Distributable Amount; Fair-Market-Value Assets; Net Investment Income:** ${pfAbsent}`,
        );
      } else {
        lines.push(
          `**Grants Paid (Part I line 25 column (a)):** ${money(f.grants_paid, pfAbsent)}`,
        );
        lines.push(
          `**Distributable Amount (required, Part X line 7):** ${money(f.distributable_amount, pfAbsent)}`,
        );
        lines.push(
          `**Fair-Market-Value Assets (EoY, Item I):** ${money(f.fair_market_value_assets, pfAbsent)}`,
        );
        lines.push(
          `**Net Investment Income (Part I line 27b):** ${money(f.net_investment_income, pfAbsent)}`,
        );
      }

      lines.push('');
      lines.push('### Salaries and Fundraising');
      const only990 = f.form_type === '990' ? NOT_EXTRACTED : notApplicableFor(f.form_type);
      const onlyEz = f.form_type === '990-EZ' ? NOT_EXTRACTED : notApplicableFor(f.form_type);
      lines.push(`**Other Salaries & Wages:** ${money(f.other_salaries_and_wages, only990)}`);
      lines.push(`**Payroll Taxes:** ${money(f.payroll_taxes, only990)}`);
      lines.push(
        `**Professional Fundraising Fees:** ${money(f.professional_fundraising_fees, only990)}`,
      );
      lines.push(
        `**Fundraising Events Gross:** ${money(f.fundraising_events_gross, programRevenueAbsent)}`,
      );
      lines.push(
        `**Fundraising Events Direct Expenses:** ${money(f.fundraising_events_direct_expenses, only990)}`,
      );
      lines.push(`**Fundraising Events Net:** ${money(f.fundraising_events_net, only990)}`);
      lines.push(
        `**Gaming and Fundraising Direct Expenses:** ${money(f.gaming_and_fundraising_direct_expenses, onlyEz)}`,
      );
      lines.push(`**Gaming and Fundraising Net:** ${money(f.gaming_and_fundraising_net, onlyEz)}`);

      const r = f.program_expense_ratio;
      lines.push('');
      lines.push('### Program Expense Ratio');
      if (r == null) {
        lines.push(`${NOT_DERIVABLE} — see notes for this form below.`);
      } else {
        lines.push(`**Ratio:** ${r.ratio != null ? PCT(r.ratio) : NOT_DERIVABLE}`);
        lines.push(`**Program Expenses:** ${money(r.program_expenses, NOT_REPORTED)}`);
        lines.push(`**Total Expenses (denominator):** ${money(r.total_expenses, NOT_REPORTED)}`);
        lines.push(`**Officer/Director Comp:** ${money(r.management_compensation, NOT_REPORTED)}`);
        lines.push(`**Other Salaries & Wages:** ${money(r.other_salaries, NOT_REPORTED)}`);
        lines.push(`**Professional Fundraising:** ${money(r.fundraising_expenses, NOT_REPORTED)}`);
        lines.push(`*${escapeMarkdownInline(r.note)}*`);
      }

      const ec = f.executive_compensation;
      lines.push('');
      lines.push(`### Executive Compensation (${ec.form_type})`);
      lines.push(
        `**Total (${ec.field_name ?? 'source field: null'}):** ${money(ec.amount, ec.field_name == null ? NOT_EXTRACTED : NOT_REPORTED)}`,
      );
    }

    for (const form of new Set(result.filings.map((f) => f.form_type))) {
      lines.push('');
      lines.push(`## Notes applying to every ${form} extracted filing above`);
      lines.push(
        form === '990'
          ? 'Program Expense Ratio: Not derivable from this data source — ProPublica returns no Form 990 Part IX program-service expense total. Read Part IX of the filing PDF for the program, management, and fundraising split.'
          : `Program Expense Ratio: Not derivable from this data source — ${form} does not contain the Form 990 Part IX functional allocation across program, management, and fundraising.`,
      );
      if (form === '990-PF') {
        lines.push(
          '990-PF investment income is Part I column (a), lines 3–4: savings interest plus dividends and securities interest; excludes capital gains, rents, and net investment income. Both components must be extracted. The distributable amount is a payout requirement, not actual payments or a compliance measure.',
        );
      } else {
        lines.push(
          form === '990'
            ? 'Other Salaries & Wages: Part IX 7A; Payroll Taxes: Part IX 10A; Professional Fundraising Fees: Part IX 11eA. Fundraising Events Gross/Direct Expenses/Net: Part VIII 8a/8b/8c. Null means not extracted.'
            : 'Fundraising Events Gross: Part I 6b. Gaming and Fundraising Direct Expenses/Net: Part I 6c/6d combine gaming and events; no event-only split is extracted. Null applicable figures mean not extracted.',
        );
        lines.push('Fundraising Events Gross excludes contributions reported separately.');
      }
      for (const note of new Set(
        result.filings
          .filter((f) => f.form_type === form)
          .map((f) => f.executive_compensation.note),
      ))
        lines.push(`*${escapeMarkdownInline(note)}*`);
    }

    if (result.filings_pdf_only.length > 0) {
      lines.push('');
      lines.push('## PDF-only Returns (no extracted data)');
      for (const f of result.filings_pdf_only) {
        const pdfLine = f.pdf_url ? markdownLink('PDF', f.pdf_url) : 'PDF not available';
        // form_type_str is '' when the upstream record omits formtype_str; omit the
        // separator rather than rendering a dangling space before the colon.
        const formLabel = f.form_type_str ? ` ${escapeMarkdownInline(f.form_type_str)}` : '';
        lines.push(
          `- FY ${f.tax_prd_yr}${formLabel}: ${pdfLine} (period: ${f.tax_prd ?? 'Not provided'})`,
        );
      }
    }

    lines.push('');
    lines.push(`*${escapeMarkdownInline(result.data_source)}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
