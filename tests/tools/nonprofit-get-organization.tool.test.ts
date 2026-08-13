/**
 * @fileoverview Tests for the nonprofit_get_organization tool.
 * @module tests/tools/nonprofit-get-organization.tool.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitGetOrganization } from '@/mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

type OrgOutput = Parameters<NonNullable<typeof nonprofitGetOrganization.format>>[0];
type OrgBlocks = ReturnType<NonNullable<typeof nonprofitGetOrganization.format>>;

/** A fully-populated format() input; overrides drive the sparse/null cases. */
const makeFormatOutput = (overrides: Partial<OrgOutput> = {}): OrgOutput => ({
  ein: 530196605,
  strein: '53-0196605',
  name: 'The Red Cross',
  sort_name: null,
  address: '430 17th St NW',
  city: 'Washington',
  state: 'DC',
  zipcode: '20006',
  ntee_code: 'P20',
  subsection_code: 3,
  ruling_date: '1946-07',
  asset_amount: 5_000_000,
  income_amount: 3_000_000,
  revenue_amount: 3_000_000,
  deductible: '1 — contributions are deductible',
  exempt_status: '1 — Unconditional Exemption',
  foundation_type: '15 — Publicly supported organization 170(b)(1)(A)(vi)',
  bmf_tax_period: '2025-06-01',
  latest_filing: {
    tax_prd_yr: 2022,
    form_type: '990',
    total_revenue: 3_000_000,
    total_expenses: 2_800_000,
    total_assets: 5_000_000,
    total_liabilities: 1_000_000,
    net_assets: 4_000_000,
    pdf_url: 'https://example.com/990.pdf',
  },
  filing_count: 1,
  data_source: 'ProPublica Nonprofit Explorer',
  propublica_url: 'https://projects.propublica.org/nonprofits/organizations/530196605',
  ...overrides,
});

const renderText = (blocks: OrgBlocks): string =>
  blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

const makeRawOrgResponse = (overrides: object = {}) => ({
  organization: {
    id: 530196605,
    ein: 530196605,
    strein: '53-0196605',
    name: 'The Red Cross',
    sort_name: null,
    address: '430 17th St NW',
    city: 'Washington',
    state: 'DC',
    zipcode: '20006',
    ntee_code: 'P20',
    subsection_code: 3,
    ruling_date: '1946-07',
    asset_amount: 5_000_000,
    income_amount: 3_000_000,
    revenue_amount: 3_000_000,
    deductibility_code: 1,
    exempt_organization_status_code: 1,
    foundation_code: 15,
    tax_period: '2025-06-01',
    ...overrides,
  },
  filings_with_data: [
    {
      tax_prd_yr: 2022,
      formtype: 0,
      pdf_url: 'https://example.com/990.pdf',
      totrevenue: 3_000_000,
      totfuncexpns: 2_800_000,
      totassetsend: 5_000_000,
      totliabend: 1_000_000,
      totnetassetend: 4_000_000,
    },
  ],
  filings_without_data: [],
  data_source: 'ProPublica Nonprofit Explorer',
});

describe('nonprofitGetOrganization', () => {
  beforeEach(() => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(makeRawOrgResponse()),
    } as unknown as svcModule.NonprofitExplorerService);
  });

  it('returns full org profile for a valid EIN (integer)', async () => {
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    expect(result.ein).toBe(530196605);
    expect(result.strein).toBe('53-0196605');
    expect(result.name).toBe('The Red Cross');
    expect(result.city).toBe('Washington');
    expect(result.filing_count).toBe(1);
    expect(result.propublica_url).toContain('530196605');
  });

  it('accepts EIN as hyphenated string', async () => {
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: '53-0196605' });
    const result = await nonprofitGetOrganization.handler(input, ctx);
    expect(result.ein).toBe(530196605);
  });

  it('accepts EIN as string without hyphen', async () => {
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: '530196605' });
    const result = await nonprofitGetOrganization.handler(input, ctx);
    expect(result.ein).toBe(530196605);
  });

  it('returns latest_filing with the most recent tax year', async () => {
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    expect(result.latest_filing).not.toBeNull();
    expect(result.latest_filing!.tax_prd_yr).toBe(2022);
    expect(result.latest_filing!.form_type).toBe('990');
    expect(result.latest_filing!.pdf_url).toBe('https://example.com/990.pdf');
  });

  it('returns null latest_filing when no filings_with_data present', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawOrgResponse(),
        filings_with_data: [],
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);
    expect(result.latest_filing).toBeNull();
    expect(result.filing_count).toBe(0);
  });

  it('decodes the IRS classification codes into code-prefixed labels', async () => {
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    expect(result.deductible).toBe('1 — contributions are deductible');
    expect(result.exempt_status).toBe('1 — Unconditional Exemption');
    expect(result.foundation_type).toBe('15 — Publicly supported organization 170(b)(1)(A)(vi)');
    expect(result.bmf_tax_period).toBe('2025-06-01');
  });

  it('decodes deductibility code 4 as deductible by treaty, not a boolean collapse', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(makeRawOrgResponse({ deductibility_code: 4 })),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    // Code 4 is a distinct third state — collapsing deductibility to true/false loses it.
    expect(result.deductible).toBe(
      '4 — contributions are deductible by treaty (foreign organizations)',
    );
  });

  it('decodes a private foundation classification distinctly from a public charity', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(makeRawOrgResponse({ foundation_code: 4 })),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    expect(result.foundation_type).toBe('4 — Private non-operating foundation');
  });

  it('retains an unrecognized IRS code instead of dropping it', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(
        makeRawOrgResponse({
          deductibility_code: 7,
          exempt_organization_status_code: 99,
          foundation_code: 88,
        }),
      ),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    expect(result.deductible).toBe('7 — unrecognized code');
    expect(result.exempt_status).toBe('99 — unrecognized code');
    expect(result.foundation_type).toBe('88 — unrecognized code');
  });

  it('returns null classification fields when the org record omits them', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(
        makeRawOrgResponse({
          deductibility_code: null,
          exempt_organization_status_code: null,
          foundation_code: null,
          tax_period: null,
        }),
      ),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    expect(result.deductible).toBeNull();
    expect(result.exempt_status).toBeNull();
    expect(result.foundation_type).toBeNull();
    expect(result.bmf_tax_period).toBeNull();
  });

  it('formats strein as XX-XXXXXXX when API returns strein: null', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawOrgResponse({ strein: null }),
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);

    // Even when the org endpoint omits strein, the handler must produce "XX-XXXXXXX" format.
    // If this fails, the code fell back to String(einNum) = "530196605" (no hyphen).
    expect(result.strein).toBe('53-0196605');
  });

  it('propagates not_found with correct code when service throws notFound', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockRejectedValue(
        notFound('No organization found for EIN 100000001.', {
          ein: 100000001,
          reason: 'not_found',
        }),
      ),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 100000001 });
    await expect(nonprofitGetOrganization.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('propagates upstream_error with correct code when service throws serviceUnavailable', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockRejectedValue(
        serviceUnavailable('ProPublica API returned HTML for EIN 530196605', {
          reason: 'upstream_error',
        }),
      ),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    await expect(nonprofitGetOrganization.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('format renders EIN and org name', () => {
    const blocks = nonprofitGetOrganization.format!(makeFormatOutput());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = renderText(blocks);
    expect(text).toContain('The Red Cross');
    expect(text).toContain('530196605');
    expect(text).toContain('https://example.com/990.pdf');
    expect(text).toContain('2022');
  });

  it('format renders the IRS classification fields', () => {
    const blocks = nonprofitGetOrganization.format!(
      makeFormatOutput({
        deductible: '1 — contributions are deductible',
        exempt_status: '1 — Unconditional Exemption',
        foundation_type: '15 — Publicly supported organization 170(b)(1)(A)(vi)',
        bmf_tax_period: '2025-06-01',
      }),
    );
    const text = renderText(blocks);

    expect(text).toContain('contributions are deductible');
    expect(text).toContain('Unconditional Exemption');
    expect(text).toContain('Publicly supported organization 170(b)(1)(A)(vi)');
    expect(text).toContain('2025-06-01');
  });

  it('format renders a revenue-only Business Master File summary', () => {
    const blocks = nonprofitGetOrganization.format!(
      makeFormatOutput({ asset_amount: null, income_amount: null, revenue_amount: 2_400_000 }),
    );
    const text = renderText(blocks);

    // Gating the whole section on asset/income dropped a populated revenue_amount.
    expect(text).toContain('IRS Business Master File Summary');
    expect(text).toContain('**Total Revenue (BMF):** $2,400,000');
    // BMF figures are IRS-recorded, so their absence is "not on record", never the
    // org's own omission.
    expect(text).toContain('**Total Assets (BMF):** Not on record');
    expect(text).toContain('**Total Income (BMF):** Not on record');
  });

  it('format renders sparse organization metadata rather than omitting it', () => {
    const blocks = nonprofitGetOrganization.format!(
      makeFormatOutput({
        address: null,
        city: null,
        state: null,
        zipcode: null,
        ntee_code: null,
        subsection_code: null,
        ruling_date: null,
        deductible: null,
        exempt_status: null,
        foundation_type: null,
        bmf_tax_period: null,
      }),
    );
    const text = renderText(blocks);

    expect(text).toContain('**Address:** Not on record');
    expect(text).toContain('**City:** Not on record');
    expect(text).toContain('**State:** Not on record');
    expect(text).toContain('**ZIP:** Not on record');
    expect(text).toContain('**NTEE Code:** Not classified');
    expect(text).toContain('**Type:** Not classified');
    expect(text).toContain('**IRS Recognition:** Not on record');
    expect(text).toContain('**Contributions Deductible:** Not on record');
    expect(text).toContain('**IRS Exemption Status:** Not on record');
    expect(text).toContain('**Foundation Classification:** Not on record');
    expect(text).toContain('**BMF Tax Period:** Not on record');
  });

  it('format renders unextracted latest-filing financials as not extracted', () => {
    const blocks = nonprofitGetOrganization.format!(
      makeFormatOutput({
        latest_filing: {
          tax_prd_yr: 2022,
          form_type: '990-PF',
          total_revenue: 10_000_000,
          total_expenses: null,
          total_assets: null,
          total_liabilities: null,
          net_assets: null,
          pdf_url: null,
        },
      }),
    );
    const text = renderText(blocks);

    expect(text).toContain('**Revenue:** $10,000,000');
    expect(text).toContain('**Expenses:** Not extracted');
    expect(text).toContain('**Assets:** Not extracted');
    expect(text).toContain('**Liabilities:** Not extracted');
    expect(text).toContain('**Net Assets:** Not extracted');
    expect(text).toContain('**Source 990 PDF:** Not yet available for this period');
  });

  it('format labels sort_name as the BMF secondary name line, not an alternate org name', () => {
    const blocks = nonprofitGetOrganization.format!(
      makeFormatOutput({ sort_name: 'Shared Services Center' }),
    );
    const text = renderText(blocks);

    // The BMF SORT_NAME field is an internal sort key, not an alternate name — it must
    // not render as an unlabelled subtitle under the org name.
    expect(text).toContain('Shared Services Center');
    expect(text).not.toContain('\n*Shared Services Center*');
    expect(text).toMatch(/Secondary Name Line.*Shared Services Center/);
  });
});
