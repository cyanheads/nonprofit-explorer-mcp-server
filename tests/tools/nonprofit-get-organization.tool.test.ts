/**
 * @fileoverview Tests for the nonprofit_get_organization tool.
 * @module tests/tools/nonprofit-get-organization.tool.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitGetOrganization } from '@/mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

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
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = nonprofitGetOrganization.input.parse({ ein: '53-0196605' });
    const result = await nonprofitGetOrganization.handler(input, ctx);
    expect(result.ein).toBe(530196605);
  });

  it('accepts EIN as string without hyphen', async () => {
    const ctx = createMockContext();
    const input = nonprofitGetOrganization.input.parse({ ein: '530196605' });
    const result = await nonprofitGetOrganization.handler(input, ctx);
    expect(result.ein).toBe(530196605);
  });

  it('returns latest_filing with the most recent tax year', async () => {
    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = nonprofitGetOrganization.input.parse({ ein: 530196605 });
    const result = await nonprofitGetOrganization.handler(input, ctx);
    expect(result.latest_filing).toBeNull();
    expect(result.filing_count).toBe(0);
  });

  it('formats strein as XX-XXXXXXX when API returns strein: null', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawOrgResponse({ strein: null }),
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext();
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
    const output = {
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
      latest_filing: {
        tax_prd_yr: 2022,
        form_type: '990' as const,
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
    };
    const blocks = nonprofitGetOrganization.format!(output);
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    expect(text).toContain('The Red Cross');
    expect(text).toContain('530196605');
    expect(text).toContain('https://example.com/990.pdf');
    expect(text).toContain('2022');
  });
});
