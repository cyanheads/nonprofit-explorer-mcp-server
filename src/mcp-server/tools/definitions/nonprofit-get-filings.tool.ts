/**
 * @fileoverview All Form 990 filings for an org with financials, executive compensation, and PDF links.
 * @module mcp-server/tools/definitions/nonprofit-get-filings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  field_name: 'compnsatncurrofcr' | 'compofficers';
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

  // 990 / 990-EZ: compnsatncurrofcr
  return {
    amount: filing.compnsatncurrofcr ?? null,
    field_name: 'compnsatncurrofcr',
    form_type: formTypeLabel(filing.formtype),
    note:
      '990/990-EZ: total compensation of current officers, directors, trustees, and key employees. ' +
      'Per-officer breakdown requires Schedule J in the source PDF.',
  };
}

export const nonprofitGetFilings = tool('nonprofit_get_filings', {
  title: 'Get Nonprofit Filings',
  description:
    'All Form 990 filings for a tax-exempt org by EIN: year-by-year revenue, expenses, assets, liabilities, net assets, revenue breakdown, executive compensation, and source PDF links. Use for trend analysis, due diligence, and accessing primary 990 documents. The filing year (tax_prd_yr) is the fiscal year of the return — data lags 1–2 years; always cite the year. An organization that resolves but has filed no 990 returns an empty filings array with a notice, not an error. Also returns filings_pdf_only — older filings with a PDF but no extracted financial data. Data from ProPublica Nonprofit Explorer, sourced from IRS Form 990 filings.',
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
        'Employer Identification Number. Use nonprofit_search to resolve an org name to its EIN.',
      ),
  }),

  output: z.object({
    ein: z.number().describe('Employer Identification Number as integer.'),
    name: z.string().describe('Legal org name per IRS.'),
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
                'Net assets/fund balances (end of year) in USD. From totnetassetend. Null when not extracted.',
              ),
            contributions_and_grants: z
              .number()
              .nullable()
              .describe(
                'Total contributions and grants (totcntrbgfts). 990/990-EZ only; null for 990-PF.',
              ),
            program_service_revenue: z
              .number()
              .nullable()
              .describe(
                'Program service revenue (totprgmrevnue). 990/990-EZ only; null for 990-PF.',
              ),
            investment_income: z
              .number()
              .nullable()
              .describe('Investment income (invstmntinc). 990/990-EZ only; null for 990-PF.'),
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
                  .describe('Total executive compensation in USD. Null when not reported.'),
                field_name: z
                  .enum(['compnsatncurrofcr', 'compofficers'])
                  .describe(
                    'Source API field the amount was read from — compnsatncurrofcr on 990 and 990-EZ, compofficers on 990-PF.',
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
                'Executive compensation summary. Field varies by form type. Per-officer breakdown requires Schedule J in the source PDF.',
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
            form_type_str: z
              .string()
              .describe('Form type string as returned by API ("990", "990EZ", "990PF").'),
            pdf_url: z
              .string()
              .nullable()
              .describe('Source Form 990 PDF link. Null for some batches.'),
          })
          .describe('Older filing with a PDF link but no extracted financial data.'),
      )
      .describe('Older filings with a PDF but no extracted financial data.'),
    total_filings_with_data: z.number().describe('Count of filings with extracted financial data.'),
    total_filings_pdf_only: z.number().describe('Count of PDF-only filings (no extracted data).'),
    data_source: z.string().describe('ProPublica + IRS attribution text.'),
    propublica_url: z.string().describe('ProPublica Nonprofit Explorer URL for this org.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the organization resolved but Nonprofit Explorer holds no filing of any kind for it — names the org and why the filing history is empty. An empty filings array without this notice means the org has filings that carry a PDF but no extracted data; read filings_pdf_only.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      thrownBy: 'service',
      when: 'The EIN does not correspond to a known organization in the Nonprofit Explorer database',
      recovery:
        'Verify the EIN with nonprofit_search. Use the integer EIN value (leading zeros stripped).',
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
    const ein = normalizeEin(input.ein);
    ctx.log.info('Fetching nonprofit filings', { ein });

    const svc = getNonprofitExplorerService();

    // Service throws notFound (reason: 'not_found') or serviceUnavailable (reason: 'upstream_error').
    const raw = await svc.getOrganization(ein, ctx);

    // Service validates organization presence and throws notFound before returning — safe to assert.
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by service not-found checks
    const org = raw.organization!;
    const filingsWithData = raw.filings_with_data ?? [];
    const filingsWithoutData = raw.filings_without_data ?? [];

    /**
     * The EIN resolved to a real organization that has simply never filed a 990 — a
     * successful lookup with an empty result set, not a failure. Returning it as an
     * error would leave a client branching on `isError` unable to tell "this org has
     * never filed" from "the lookup failed".
     */
    if (filingsWithData.length === 0 && filingsWithoutData.length === 0) {
      ctx.enrich.notice(
        `Organization "${org.name}" (EIN ${ein}) resolved, but Nonprofit Explorer holds no Form 990 for it. ` +
          'Organizations with under $50,000 in annual revenue file Form 990N (e-Postcard), which this dataset does not cover. ' +
          'Filings also lag 1–2 years, so a recently formed organization may not have one on record yet.',
      );
    }

    // Sort by fiscal year descending (newest first)
    const sortedFilings = [...filingsWithData].sort(
      (a, b) => (b.tax_prd_yr ?? 0) - (a.tax_prd_yr ?? 0),
    );

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
      net_assets: f.totnetassetend ?? null,
      contributions_and_grants: f.totcntrbgfts ?? null,
      program_service_revenue: f.totprgmrevnue ?? null,
      investment_income: f.invstmntinc ?? null,
      /**
       * Not derived. `totfuncexpns` is Form 990 Part IX column (A); the program-service
       * total is column (B), which ProPublica does not return, and Part IX allocates
       * every expense line across program, management, and fundraising — not just
       * `compnsatncurrofcr`, `othrsalwages`, and `profndraising`.
       */
      program_expense_ratio: null,
      executive_compensation: buildExecComp(f),
    }));

    const mappedPdfOnly = filingsWithoutData.map((f) => ({
      tax_prd_yr: f.tax_prd_yr ?? 0,
      form_type_str: f.formtype_str ?? '',
      pdf_url: f.pdf_url ?? null,
    }));

    const einNum = org.ein ?? ein;

    return {
      ein: einNum,
      name: org.name ?? '',
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

    lines.push(`# ${result.name} — Form 990 Filings`);
    lines.push(`**EIN:** ${result.ein}`);
    lines.push(
      `**Filings with data:** ${result.total_filings_with_data} | ` +
        `**PDF-only filings:** ${result.total_filings_pdf_only}`,
    );
    lines.push(`**Profile:** ${result.propublica_url}`);
    lines.push('');
    lines.push(
      '> ⚠️ Data lags 1–2 years. FY shown is the fiscal year, not the current year. Always cite the year.',
    );

    if (result.filings.length === 0) {
      lines.push('');
      lines.push('*No Form 990 with extracted financial data on record for this organization.*');
    }

    for (const f of result.filings) {
      lines.push('');
      lines.push(`## FY ${f.tax_prd_yr} — ${f.form_type} (period: ${f.tax_prd})`);

      lines.push(`**Source 990 PDF:** ${f.pdf_url ?? 'Not yet available for this period'}`);
      lines.push(`**Last updated:** ${f.updated ?? 'Not provided'}`);

      lines.push('');
      lines.push('### Financials');
      lines.push(`**Revenue:** ${money(f.total_revenue)}`);
      lines.push(`**Expenses:** ${money(f.total_expenses)}`);
      lines.push(`**Assets (EoY):** ${money(f.total_assets)}`);
      lines.push(`**Liabilities (EoY):** ${money(f.total_liabilities)}`);
      lines.push(`**Net Assets (EoY):** ${money(f.net_assets)}`);

      /**
       * The revenue-breakdown fields are 990/990-EZ line items that do not exist on a
       * 990-PF at all. "Not applicable for 990-PF" and "not extracted" are different
       * facts about the same null, so the form type picks the label.
       */
      const breakdownAbsent =
        f.form_type === '990-PF' ? notApplicableFor(f.form_type) : NOT_EXTRACTED;
      lines.push('');
      lines.push('### Revenue Breakdown');
      lines.push(
        `**Contributions & Grants:** ${money(f.contributions_and_grants, breakdownAbsent)}`,
      );
      lines.push(
        `**Program Service Revenue:** ${money(f.program_service_revenue, breakdownAbsent)}`,
      );
      lines.push(`**Investment Income:** ${money(f.investment_income, breakdownAbsent)}`);

      const r = f.program_expense_ratio;
      lines.push('');
      lines.push('### Program Expense Ratio');
      if (r == null) {
        lines.push(
          `${NOT_DERIVABLE} — ProPublica returns no Form 990 Part IX program-service expense total. Read Part IX of the filing PDF for the program, management, and fundraising split.`,
        );
      } else {
        lines.push(`**Ratio:** ${r.ratio != null ? PCT(r.ratio) : NOT_DERIVABLE}`);
        lines.push(`**Program Expenses:** ${money(r.program_expenses, NOT_REPORTED)}`);
        lines.push(`**Total Expenses (denominator):** ${money(r.total_expenses, NOT_REPORTED)}`);
        lines.push(`**Officer/Director Comp:** ${money(r.management_compensation, NOT_REPORTED)}`);
        lines.push(`**Other Salaries & Wages:** ${money(r.other_salaries, NOT_REPORTED)}`);
        lines.push(`**Professional Fundraising:** ${money(r.fundraising_expenses, NOT_REPORTED)}`);
        lines.push(`*${r.note}*`);
      }

      const ec = f.executive_compensation;
      lines.push('');
      lines.push(`### Executive Compensation (${ec.form_type})`);
      lines.push(`**Total (${ec.field_name}):** ${money(ec.amount, NOT_REPORTED)}`);
      lines.push(`*${ec.note}*`);
    }

    if (result.filings_pdf_only.length > 0) {
      lines.push('');
      lines.push('## Older Filings (PDF only — no extracted data)');
      for (const f of result.filings_pdf_only) {
        const pdfLine = f.pdf_url ? `[PDF](${f.pdf_url})` : 'PDF not available';
        // form_type_str is '' when the upstream record omits formtype_str; omit the
        // separator rather than rendering a dangling space before the colon.
        const formLabel = f.form_type_str ? ` ${f.form_type_str}` : '';
        lines.push(`- FY ${f.tax_prd_yr}${formLabel}: ${pdfLine}`);
      }
    }

    lines.push('');
    lines.push(`*${result.data_source}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
