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

/** A value the IRS Business Master File does not carry for this organization. */
const NOT_ON_RECORD = 'Not on record';
/** A figure ProPublica did not extract from the filing. */
const NOT_EXTRACTED = 'Not extracted';
/** No IRS classification code on record for this organization. */
const NOT_CLASSIFIED = 'Not classified';

/** Render a nullable USD amount, naming why it is absent rather than omitting the line. */
const money = (n: number | null, absent: string = NOT_EXTRACTED) => (n == null ? absent : USD(n));

/** Map formtype integer to form label. */
function formTypeLabel(ft: number | undefined): '990' | '990-EZ' | '990-PF' {
  if (ft === 1) return '990-EZ';
  if (ft === 2) return '990-PF';
  return '990';
}

/**
 * IRS Exempt Organizations Business Master File code tables, per the published EO BMF
 * layout (https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf). The upstream record carries
 * opaque integers; decoding them here means the caller does not have to hold the tables.
 */
const DEDUCTIBILITY_LABELS: Readonly<Record<number, string>> = {
  1: 'contributions are deductible',
  2: 'contributions are not deductible',
  4: 'contributions are deductible by treaty (foreign organizations)',
};

const EXEMPT_STATUS_LABELS: Readonly<Record<number, string>> = {
  1: 'Unconditional Exemption',
  2: 'Conditional Exemption',
  12: 'Trust described in section 4947(a)(2)',
  25: 'Organization terminating its private foundation status under section 507(b)(1)(B)',
};

const FOUNDATION_LABELS: Readonly<Record<number, string>> = {
  0: 'All organizations except 501(c)(3)',
  2: 'Private operating foundation exempt from investment-income excise tax',
  3: 'Private operating foundation (other)',
  4: 'Private non-operating foundation',
  9: 'Suspense',
  10: 'Church 170(b)(1)(A)(i)',
  11: 'School 170(b)(1)(A)(ii)',
  12: 'Hospital or medical research organization 170(b)(1)(A)(iii)',
  13: 'Organization operated for the benefit of a college or university 170(b)(1)(A)(iv)',
  14: 'Governmental unit 170(b)(1)(A)(v)',
  15: 'Publicly supported organization 170(b)(1)(A)(vi)',
  16: 'Publicly supported organization 509(a)(2)',
  17: 'Supporting organization 509(a)(3)',
  18: 'Organization operated to test for public safety 509(a)(4)',
  21: '509(a)(3) Type I supporting organization',
  22: '509(a)(3) Type II supporting organization',
  23: '509(a)(3) Type III supporting organization, functionally integrated',
  24: '509(a)(3) Type III supporting organization, not functionally integrated',
  25: 'Agriculture research organization 170(b)(1)(A)(ix)',
};

/**
 * Render an IRS code as `<code> — <label>`. The raw code is kept in the value so the
 * figure stays traceable to the upstream record, and a code outside the published table
 * is surfaced rather than dropped — the tables gain entries over time.
 */
function decodeIrsCode(
  code: number | null | undefined,
  labels: Readonly<Record<number, string>>,
): string | null {
  if (code == null) return null;
  return `${code} — ${labels[code] ?? 'unrecognized code'}`;
}

export const nonprofitGetOrganization = tool('nonprofit_get_organization', {
  title: 'Get Nonprofit Organization',
  description:
    'Full profile for a single tax-exempt org by EIN: legal name, address, NTEE classification, 501(c) type, IRS ruling date, and a financial snapshot from the most recent Form 990 filing (revenue, expenses, assets, net assets, and the source PDF link). Also returns the IRS Business Master File standing — whether contributions are deductible, exemption status, and public-charity vs. private-foundation classification. Use nonprofit_search first if you only have an org name — this tool requires an EIN. Data lags 1–2 years; the tax year is shown prominently. Data from ProPublica Nonprofit Explorer, sourced from IRS Form 990 filings.',
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
        'Employer Identification Number. Accepts integer (530196605) or string with optional hyphen ("53-0196605"). Obtain from nonprofit_search results.',
      ),
  }),

  output: z.object({
    ein: z.number().describe('Employer Identification Number as integer.'),
    strein: z.string().describe('EIN in "XX-XXXXXXX" format.'),
    name: z.string().describe('Legal org name per IRS.'),
    sort_name: z
      .string()
      .nullable()
      .describe(
        'IRS Business Master File secondary name line (SORT_NAME) — an internal sort key such as a division or service-center label, not an alternate organization name. Null for most orgs.',
      ),
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
      .describe(
        '501(c) subsection number (e.g., 3 = charitable organization, covering both public charities and private foundations — see foundation_type to tell them apart). Null when not classified.',
      ),
    ruling_date: z
      .string()
      .nullable()
      .describe('ISO date of IRS recognition (e.g., "1946-07"). Null when not on record.'),
    asset_amount: z
      .number()
      .nullable()
      .describe('Most recent IRS BMF total assets in USD. Null when not on record.'),
    income_amount: z
      .number()
      .nullable()
      .describe('Most recent IRS BMF total income in USD. Null when not on record.'),
    revenue_amount: z
      .number()
      .nullable()
      .describe('Most recent IRS BMF total revenue in USD. Null when not on record.'),
    deductible: z
      .string()
      .nullable()
      .describe(
        'Whether contributions to this org are tax-deductible, as "<IRS code> — <meaning>". Three states, not two: code 1 deductible, code 2 not deductible, code 4 deductible by treaty (foreign orgs). Null when the IRS Business Master File records no deductibility code.',
      ),
    exempt_status: z
      .string()
      .nullable()
      .describe(
        'IRS exemption status as "<IRS code> — <meaning>"; code 1 is an unconditional exemption. This records what the IRS granted, not whether the exemption is still in force — the Business Master File is a lagging snapshot and automatic revocations are published separately. Null when the Business Master File records no status code.',
      ),
    foundation_type: z
      .string()
      .nullable()
      .describe(
        'IRS foundation classification as "<IRS code> — <meaning>", separating public charities (codes 10–25) from private foundations (codes 2–4). Codes 0 (all organizations except 501(c)(3)) and 9 (suspense) fall outside both groups. Null when the IRS Business Master File records no foundation code.',
      ),
    bmf_tax_period: z
      .string()
      .nullable()
      .describe(
        'Tax period of the latest return recorded in the IRS Business Master File (e.g. "2025-06-01"). Often more recent than latest_filing.tax_prd_yr, which reflects the newest 990 ProPublica has extracted. Null when not on record.',
      ),
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
      deductible: decodeIrsCode(org.deductibility_code, DEDUCTIBILITY_LABELS),
      exempt_status: decodeIrsCode(org.exempt_organization_status_code, EXEMPT_STATUS_LABELS),
      foundation_type: decodeIrsCode(org.foundation_code, FOUNDATION_LABELS),
      bmf_tax_period: org.tax_period ?? null,
      latest_filing: latestFiling,
      filing_count: filings.length,
      data_source: raw.data_source ?? 'ProPublica Nonprofit Explorer, IRS Form 990 data.',
      propublica_url: `https://projects.propublica.org/nonprofits/organizations/${einNum}`,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    /**
     * Every nullable field renders, null included, with a label naming *why* it is null.
     * Dropping one leaves a `content[]`-only client unable to tell a value the IRS never
     * recorded from a field the response never carried, and collapsing the labels would
     * lose the distinction between unrecorded, unclassified, and unextracted.
     */
    lines.push(`# ${result.name}`);
    lines.push('');

    lines.push(`**EIN:** ${result.strein} (${result.ein})`);
    lines.push(`**BMF Secondary Name Line:** ${result.sort_name ?? NOT_ON_RECORD}`);
    lines.push(
      `**Type:** ${result.subsection_code != null ? `501(c)(${result.subsection_code})` : NOT_CLASSIFIED}`,
    );
    lines.push(`**NTEE Code:** ${result.ntee_code ?? NOT_CLASSIFIED}`);
    lines.push(`**IRS Recognition:** ${result.ruling_date ?? NOT_ON_RECORD}`);
    lines.push(`**Contributions Deductible:** ${result.deductible ?? NOT_ON_RECORD}`);
    lines.push(`**IRS Exemption Status:** ${result.exempt_status ?? NOT_ON_RECORD}`);
    lines.push(`**Foundation Classification:** ${result.foundation_type ?? NOT_ON_RECORD}`);
    lines.push(`**BMF Tax Period:** ${result.bmf_tax_period ?? NOT_ON_RECORD}`);
    lines.push('');

    lines.push(`**Address:** ${result.address ?? NOT_ON_RECORD}`);
    lines.push(
      `**City:** ${result.city ?? NOT_ON_RECORD} | **State:** ${result.state ?? NOT_ON_RECORD} | ` +
        `**ZIP:** ${result.zipcode ?? NOT_ON_RECORD}`,
    );

    lines.push(`**Filings on record:** ${result.filing_count}`);
    lines.push('');
    lines.push(`**Profile:** ${result.propublica_url}`);

    if (result.latest_filing) {
      const f = result.latest_filing;
      lines.push('');
      lines.push(`## Latest Filing (${f.form_type}, FY ${f.tax_prd_yr})`);
      lines.push('> ⚠️ Data lags 1–2 years. FY shown is the fiscal year, not the current year.');
      lines.push(`**Revenue:** ${money(f.total_revenue)}`);
      lines.push(`**Expenses:** ${money(f.total_expenses)}`);
      lines.push(`**Assets:** ${money(f.total_assets)}`);
      lines.push(`**Liabilities:** ${money(f.total_liabilities)}`);
      lines.push(`**Net Assets:** ${money(f.net_assets)}`);
      lines.push(`**Source 990 PDF:** ${f.pdf_url ?? 'Not yet available for this period'}`);
    } else {
      lines.push('');
      lines.push('*No Form 990 data on file. Org may file Form 990N (under $50K revenue).*');
    }

    lines.push('');
    lines.push('## IRS Business Master File Summary');
    lines.push(`**Total Assets (BMF):** ${money(result.asset_amount, NOT_ON_RECORD)}`);
    lines.push(`**Total Income (BMF):** ${money(result.income_amount, NOT_ON_RECORD)}`);
    lines.push(`**Total Revenue (BMF):** ${money(result.revenue_amount, NOT_ON_RECORD)}`);

    lines.push('');
    lines.push(`*${result.data_source}*`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
