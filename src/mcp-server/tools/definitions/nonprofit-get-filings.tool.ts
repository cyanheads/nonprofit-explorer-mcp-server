/**
 * @fileoverview All Form 990 filings for an org with financials, program-expense ratio, and PDF links.
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

/** Map formtype integer to form label. */
function formTypeLabel(ft: number | undefined): '990' | '990-EZ' | '990-PF' {
  if (ft === 1) return '990-EZ';
  if (ft === 2) return '990-PF';
  return '990';
}

/** Compute program-expense ratio for 990/990-EZ (formtype 0 or 1). Returns null for 990-PF. */
function computeProgramExpenseRatio(filing: RawFiling): {
  ratio: number | null;
  program_expenses: number | null;
  total_expenses: number | null;
  management_compensation: number | null;
  other_salaries: number | null;
  fundraising_expenses: number | null;
  note: string;
} | null {
  if (filing.formtype === 2) {
    // 990-PF: fields not available
    return null;
  }

  const total = filing.totfuncexpns ?? null;
  const officerComp = filing.compnsatncurrofcr ?? null;
  const otherSalaries = filing.othrsalwages ?? null;
  const fundraising = filing.profndraising ?? null;

  // Only compute ratio when we have enough inputs
  let ratio: number | null = null;
  let programExpenses: number | null = null;

  if (
    total != null &&
    officerComp != null &&
    otherSalaries != null &&
    fundraising != null &&
    total > 0
  ) {
    programExpenses = total - officerComp - otherSalaries - fundraising;
    ratio = programExpenses / total;
  } else if (total != null && total > 0) {
    // Partial: compute what we can
    const deductions = (officerComp ?? 0) + (otherSalaries ?? 0) + (fundraising ?? 0);
    programExpenses = total - deductions;
    ratio = programExpenses / total;
  }

  return {
    ratio,
    program_expenses: programExpenses,
    total_expenses: total,
    management_compensation: officerComp,
    other_salaries: otherSalaries,
    fundraising_expenses: fundraising,
    note:
      'Program expenses = total − officer/director comp − other salaries/wages − professional fundraising. ' +
      'Approximation — consult the source PDF Part IX for the full expense schedule.',
  };
}

/** Build executive compensation object. Returns null if no compensation field available. */
function buildExecComp(filing: RawFiling): {
  amount: number | null;
  field_name: string;
  form_type: string;
  note: string;
} | null {
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
    form_type: filing.formtype === 1 ? '990-EZ' : '990',
    note:
      '990/990-EZ: total compensation of current officers, directors, trustees, and key employees. ' +
      'Per-officer breakdown requires Schedule J in the source PDF.',
  };
}

export const nonprofitGetFilings = tool('nonprofit_get_filings', {
  title: 'Get Nonprofit Filings',
  description:
    'All Form 990 filings for a tax-exempt org by EIN: year-by-year revenue, expenses, assets, ' +
    'program-expense ratio (with inputs shown), executive compensation, and source PDF/XML links. ' +
    'Use for trend analysis, due diligence, and accessing primary 990 documents. ' +
    'The filing year (tax_prd_yr) is the fiscal year of the return — data lags 1–2 years; always cite the year. ' +
    'Program expense ratio is computed as (total_expenses − officer comp − other wages − fundraising) / total_expenses ' +
    'for 990/990-EZ; not available for 990-PF. ' +
    'Also returns filings_pdf_only — older filings with a PDF but no extracted financial data. ' +
    'Data from ProPublica Nonprofit Explorer, sourced from IRS Form 990 filings.',
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
                    'Program expense ratio as decimal 0.0–1.0. Null if inputs insufficient.',
                  ),
                program_expenses: z
                  .number()
                  .nullable()
                  .describe(
                    'Computed program expenses (total − officer comp − other wages − fundraising) in USD.',
                  ),
                total_expenses: z
                  .number()
                  .nullable()
                  .describe('Total functional expenses (denominator) in USD. From totfuncexpns.'),
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
                  .describe('Methodology note explaining the computation and its limitations.'),
              })
              .nullable()
              .describe(
                'Program-expense ratio with inputs. Null for 990-PF (different field set). ' +
                  'Approximation — consult the source PDF for the full expense schedule.',
              ),
            executive_compensation: z
              .object({
                amount: z
                  .number()
                  .nullable()
                  .describe('Total executive compensation in USD. Null when not reported.'),
                field_name: z
                  .string()
                  .describe(
                    'Source API field name for transparency (compnsatncurrofcr or compofficers).',
                  ),
                form_type: z
                  .string()
                  .describe('Form type this compensation field is sourced from.'),
                note: z
                  .string()
                  .describe(
                    'Plain-English description of what this field covers and where to find per-officer detail.',
                  ),
              })
              .nullable()
              .describe(
                'Executive compensation summary. Field varies by form type. ' +
                  'Per-officer breakdown requires Schedule J in the source PDF.',
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

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The EIN does not correspond to a known organization in the Nonprofit Explorer database',
      recovery:
        'Verify the EIN with nonprofit_search. Use the integer EIN value (leading zeros stripped).',
    },
    {
      reason: 'no_filings',
      code: JsonRpcErrorCode.NotFound,
      when: 'Org is known but has no Form 990 data in Nonprofit Explorer — typically a small org filing Form 990N (e-Postcard)',
      recovery:
        'Small organizations with under $50,000 in revenue file Form 990N (e-Postcard), ' +
        'which is not included in Nonprofit Explorer. The org exists but has no 990 data to display.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
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

    // Check for org with no filings at all (small org, 990N filer)
    if (filingsWithData.length === 0 && filingsWithoutData.length === 0) {
      throw ctx.fail(
        'no_filings',
        `Organization "${org.name}" (EIN ${ein}) has no Form 990 data in Nonprofit Explorer. ` +
          'It may file Form 990N (e-Postcard) for organizations with under $50,000 in annual revenue.',
        { ...ctx.recoveryFor('no_filings') },
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
      program_expense_ratio: computeProgramExpenseRatio(f),
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

    for (const f of result.filings) {
      lines.push('');
      lines.push(`## FY ${f.tax_prd_yr} — ${f.form_type} (period: ${f.tax_prd})`);

      if (f.pdf_url) {
        lines.push(`**Source 990 PDF:** ${f.pdf_url}`);
      } else {
        lines.push('**Source 990 PDF:** Not yet available for this period');
      }
      if (f.updated) lines.push(`**Last updated:** ${f.updated}`);

      lines.push('');
      lines.push('### Financials');
      if (f.total_revenue != null) lines.push(`**Revenue:** ${USD(f.total_revenue)}`);
      if (f.total_expenses != null) lines.push(`**Expenses:** ${USD(f.total_expenses)}`);
      if (f.total_assets != null) lines.push(`**Assets (EoY):** ${USD(f.total_assets)}`);
      if (f.total_liabilities != null)
        lines.push(`**Liabilities (EoY):** ${USD(f.total_liabilities)}`);
      if (f.net_assets != null) lines.push(`**Net Assets (EoY):** ${USD(f.net_assets)}`);

      if (
        f.contributions_and_grants != null ||
        f.program_service_revenue != null ||
        f.investment_income != null
      ) {
        lines.push('');
        lines.push('### Revenue Breakdown');
        if (f.contributions_and_grants != null)
          lines.push(`**Contributions & Grants:** ${USD(f.contributions_and_grants)}`);
        if (f.program_service_revenue != null)
          lines.push(`**Program Service Revenue:** ${USD(f.program_service_revenue)}`);
        if (f.investment_income != null)
          lines.push(`**Investment Income:** ${USD(f.investment_income)}`);
      }

      if (f.program_expense_ratio != null) {
        const r = f.program_expense_ratio;
        lines.push('');
        lines.push('### Program Expense Ratio');
        if (r.ratio != null) lines.push(`**Ratio:** ${PCT(r.ratio)}`);
        if (r.program_expenses != null)
          lines.push(`**Program Expenses:** ${USD(r.program_expenses)}`);
        if (r.total_expenses != null)
          lines.push(`**Total Expenses (denominator):** ${USD(r.total_expenses)}`);
        if (r.management_compensation != null)
          lines.push(`**Officer/Director Comp:** ${USD(r.management_compensation)}`);
        if (r.other_salaries != null)
          lines.push(`**Other Salaries & Wages:** ${USD(r.other_salaries)}`);
        if (r.fundraising_expenses != null)
          lines.push(`**Professional Fundraising:** ${USD(r.fundraising_expenses)}`);
        lines.push(`*${r.note}*`);
      }

      if (f.executive_compensation != null) {
        const ec = f.executive_compensation;
        lines.push('');
        lines.push(`### Executive Compensation (${ec.form_type})`);
        if (ec.amount != null) {
          lines.push(`**Total (${ec.field_name}):** ${USD(ec.amount)}`);
        } else {
          lines.push(`**Total (${ec.field_name}):** Not reported`);
        }
        lines.push(`*${ec.note}*`);
      }
    }

    if (result.filings_pdf_only.length > 0) {
      lines.push('');
      lines.push('## Older Filings (PDF only — no extracted data)');
      for (const f of result.filings_pdf_only) {
        const pdfLine = f.pdf_url ? `[PDF](${f.pdf_url})` : 'PDF not available';
        lines.push(`- FY ${f.tax_prd_yr} ${f.form_type_str}: ${pdfLine}`);
      }
    }

    lines.push('');
    lines.push(`*${result.data_source}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
