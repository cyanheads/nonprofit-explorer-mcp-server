/**
 * @fileoverview Full org profile by EIN: legal identity, IRS classification, and financial snapshot.
 * @module mcp-server/tools/definitions/nonprofit-get-organization.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  formatEin,
  getNonprofitExplorerService,
  normalizeEin,
} from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

const USD = (n: number) => `$${n.toLocaleString()}`;

/** Map formtype integer to form label. */
function formTypeLabel(ft: number | undefined): '990' | '990-EZ' | '990-PF' {
  if (ft === 1) return '990-EZ';
  if (ft === 2) return '990-PF';
  return '990';
}

export const nonprofitGetOrganization = tool('nonprofit_get_organization', {
  title: 'Get Nonprofit Organization',
  description:
    'Full profile for a single tax-exempt org by EIN: legal name, address, NTEE classification, ' +
    '501(c) type, IRS ruling date, and a financial snapshot from the most recent Form 990 filing ' +
    '(revenue, expenses, assets, net assets, and the source PDF link). ' +
    'Use nonprofit_search first if you only have an org name — this tool requires an EIN. ' +
    'Data lags 1–2 years; the tax year is shown prominently. ' +
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
        'Employer Identification Number. Accepts integer (530196605) or string with optional hyphen ' +
          '("53-0196605"). Obtain from nonprofit_search results.',
      ),
  }),

  output: z.object({
    ein: z.number().describe('Employer Identification Number as integer.'),
    strein: z.string().describe('EIN in "XX-XXXXXXX" format.'),
    name: z.string().describe('Legal org name per IRS.'),
    sort_name: z
      .string()
      .nullable()
      .describe('Alternate or subtitle name from the org record. Null when absent.'),
    address: z.string().nullable().describe('Street address. Null when not on record.'),
    city: z.string().nullable().describe('City. Null when not on record.'),
    state: z
      .string()
      .nullable()
      .describe('Two-letter state abbreviation. Null when not on record.'),
    zipcode: z.string().nullable().describe('ZIP code. Null when not on record.'),
    ntee_code: z
      .string()
      .nullable()
      .describe('Full NTEE code (e.g., "E210" = hospital). Null when unclassified.'),
    subsection_code: z
      .number()
      .nullable()
      .describe('501(c) subsection number (e.g., 3 = public charity). Null when not classified.'),
    ruling_date: z
      .string()
      .nullable()
      .describe('ISO date of IRS recognition (e.g., "1946-07"). Null when not on record.'),
    asset_amount: z
      .number()
      .nullable()
      .describe('Most recent IRS BMF total assets in USD. Null when not reported.'),
    income_amount: z
      .number()
      .nullable()
      .describe('Most recent IRS BMF total income in USD. Null when not reported.'),
    revenue_amount: z
      .number()
      .nullable()
      .describe('Most recent IRS BMF total revenue in USD. Null when not reported.'),
    latest_filing: z
      .object({
        tax_prd_yr: z
          .number()
          .describe(
            'Fiscal year of this filing (e.g., 2023). NOT the current year — data lags 1–2 years.',
          ),
        form_type: z.enum(['990', '990-EZ', '990-PF']).describe('IRS form type filed.'),
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
        pdf_url: z
          .string()
          .nullable()
          .describe(
            'Source Form 990 PDF link. Null for some IRS processing batches — check filings via nonprofit_get_filings.',
          ),
      })
      .nullable()
      .describe(
        'Financial snapshot from the most recent Form 990. Null if no filings_with_data are available.',
      ),
    filing_count: z.number().describe('Total filings with extracted data on record.'),
    data_source: z.string().describe('ProPublica + IRS attribution text.'),
    propublica_url: z.string().describe('ProPublica Nonprofit Explorer URL for this org.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The EIN does not correspond to a known organization in the Nonprofit Explorer database',
      recovery:
        'Verify the EIN with nonprofit_search. EINs with leading zeros are stored without them — try the integer value.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'ProPublica API returns a non-JSON body (HTML 500) or network error',
      retryable: true,
      recovery: 'Wait a moment and retry.',
    },
  ],

  async handler(input, ctx) {
    const ein = normalizeEin(input.ein);
    ctx.log.info('Fetching nonprofit organization', { ein });

    const svc = getNonprofitExplorerService();

    // Service throws notFound (with reason: 'not_found') or serviceUnavailable (reason: 'upstream_error')
    // propagated unchanged by the framework auto-classifier.
    const raw = await svc.getOrganization(ein, ctx);

    // Service validates organization presence and throws notFound before returning — safe to assert.
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by service not-found checks
    const org = raw.organization!;
    const filings = raw.filings_with_data ?? [];

    // Pick the latest filing (most recent tax_prd_yr)
    const sorted = [...filings].sort((a, b) => (b.tax_prd_yr ?? 0) - (a.tax_prd_yr ?? 0));
    const latest = sorted[0] ?? null;

    const latestFiling = latest
      ? {
          tax_prd_yr: latest.tax_prd_yr ?? 0,
          form_type: formTypeLabel(latest.formtype),
          total_revenue: latest.totrevenue ?? null,
          total_expenses: latest.totfuncexpns ?? null,
          total_assets: latest.totassetsend ?? null,
          total_liabilities: latest.totliabend ?? null,
          net_assets: latest.totnetassetend ?? null,
          pdf_url: latest.pdf_url ?? null,
        }
      : null;

    const einNum = org.ein ?? ein;
    const strein = org.strein ?? formatEin(einNum);

    return {
      ein: einNum,
      strein,
      name: org.name ?? '',
      sort_name: org.sort_name ?? null,
      address: org.address ?? null,
      city: org.city ?? null,
      state: org.state ?? null,
      zipcode: org.zipcode ?? null,
      ntee_code: org.ntee_code ?? null,
      subsection_code: org.subsection_code ?? null,
      ruling_date: org.ruling_date ?? null,
      asset_amount: org.asset_amount ?? null,
      income_amount: org.income_amount ?? null,
      revenue_amount: org.revenue_amount ?? null,
      latest_filing: latestFiling,
      filing_count: filings.length,
      data_source: raw.data_source ?? 'ProPublica Nonprofit Explorer, IRS Form 990 data.',
      propublica_url: `https://projects.propublica.org/nonprofits/organizations/${einNum}`,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`# ${result.name}`);
    if (result.sort_name) lines.push(`*${result.sort_name}*`);
    lines.push('');

    lines.push(`**EIN:** ${result.strein} (${result.ein})`);
    if (result.subsection_code != null) {
      lines.push(`**Type:** 501(c)(${result.subsection_code})`);
    }
    if (result.ntee_code) lines.push(`**NTEE Code:** ${result.ntee_code}`);
    if (result.ruling_date) lines.push(`**IRS Recognition:** ${result.ruling_date}`);
    lines.push('');

    const addrParts = [result.address, result.city, result.state, result.zipcode].filter(Boolean);
    if (addrParts.length > 0) {
      lines.push(`**Address:** ${addrParts.join(', ')}`);
    }

    lines.push(`**Filings on record:** ${result.filing_count}`);
    lines.push('');
    lines.push(`**Profile:** ${result.propublica_url}`);

    if (result.latest_filing) {
      const f = result.latest_filing;
      lines.push('');
      lines.push(`## Latest Filing (${f.form_type}, FY ${f.tax_prd_yr})`);
      lines.push('> ⚠️ Data lags 1–2 years. FY shown is the fiscal year, not the current year.');
      if (f.total_revenue != null) lines.push(`**Revenue:** ${USD(f.total_revenue)}`);
      if (f.total_expenses != null) lines.push(`**Expenses:** ${USD(f.total_expenses)}`);
      if (f.total_assets != null) lines.push(`**Assets:** ${USD(f.total_assets)}`);
      if (f.total_liabilities != null) lines.push(`**Liabilities:** ${USD(f.total_liabilities)}`);
      if (f.net_assets != null) lines.push(`**Net Assets:** ${USD(f.net_assets)}`);
      if (f.pdf_url) {
        lines.push(`**Source 990 PDF:** ${f.pdf_url}`);
      } else {
        lines.push('**Source 990 PDF:** Not yet available for this period');
      }
    } else {
      lines.push('');
      lines.push('*No Form 990 data on file. Org may file Form 990N (under $50K revenue).*');
    }

    if (result.asset_amount != null || result.income_amount != null) {
      lines.push('');
      lines.push('## IRS Business Master File Summary');
      if (result.asset_amount != null)
        lines.push(`**Total Assets (BMF):** ${USD(result.asset_amount)}`);
      if (result.income_amount != null)
        lines.push(`**Total Income (BMF):** ${USD(result.income_amount)}`);
      if (result.revenue_amount != null)
        lines.push(`**Total Revenue (BMF):** ${USD(result.revenue_amount)}`);
    }

    lines.push('');
    lines.push(`*${result.data_source}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
