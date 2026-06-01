/**
 * @fileoverview Tests for the nonprofit_get_filings tool.
 * @module tests/tools/nonprofit-get-filings.tool.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitGetFilings } from '@/mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

const makeRawFilingsResponse = (overrides: object = {}) => ({
  organization: {
    id: 530196605,
    ein: 530196605,
    strein: '53-0196605',
    name: 'The Red Cross',
    address: '430 17th St NW',
    city: 'Washington',
    state: 'DC',
    ...overrides,
  },
  filings_with_data: [
    {
      tax_prd: 202212,
      tax_prd_yr: 2022,
      formtype: 0,
      pdf_url: 'https://example.com/990-2022.pdf',
      updated: '2024-01-15T00:00:00Z',
      totrevenue: 3_000_000,
      totfuncexpns: 2_800_000,
      totassetsend: 5_000_000,
      totliabend: 1_000_000,
      totnetassetend: 4_000_000,
      totcntrbgfts: 2_500_000,
      totprgmrevnue: 400_000,
      invstmntinc: 100_000,
      compnsatncurrofcr: 250_000,
      othrsalwages: 1_200_000,
      profndraising: 50_000,
    },
    {
      tax_prd: 202112,
      tax_prd_yr: 2021,
      formtype: 0,
      pdf_url: 'https://example.com/990-2021.pdf',
      updated: '2023-01-15T00:00:00Z',
      totrevenue: 2_800_000,
      totfuncexpns: 2_600_000,
      totassetsend: 4_800_000,
      totliabend: 950_000,
      totnetassetend: 3_850_000,
      compnsatncurrofcr: 240_000,
      othrsalwages: 1_100_000,
      profndraising: 45_000,
    },
  ],
  filings_without_data: [
    { tax_prd_yr: 2018, formtype: '990', pdf_url: 'https://example.com/990-2018.pdf' },
  ],
  data_source: 'ProPublica Nonprofit Explorer',
});

describe('nonprofitGetFilings', () => {
  beforeEach(() => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(makeRawFilingsResponse()),
    } as unknown as svcModule.NonprofitExplorerService);
  });

  it('returns filings sorted by tax year descending', async () => {
    const ctx = createMockContext();
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings).toHaveLength(2);
    expect(result.filings[0]!.tax_prd_yr).toBe(2022);
    expect(result.filings[1]!.tax_prd_yr).toBe(2021);
  });

  it('computes program expense ratio correctly', async () => {
    const ctx = createMockContext();
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    const latest = result.filings[0]!;
    expect(latest.program_expense_ratio).not.toBeNull();
    const ratio = latest.program_expense_ratio!;

    // program = 2800000 - 250000 - 1200000 - 50000 = 1300000
    expect(ratio.program_expenses).toBe(1_300_000);
    // ratio = 1300000 / 2800000 ≈ 0.464
    expect(ratio.ratio).toBeCloseTo(1_300_000 / 2_800_000, 5);
    expect(ratio.management_compensation).toBe(250_000);
    expect(ratio.other_salaries).toBe(1_200_000);
    expect(ratio.fundraising_expenses).toBe(50_000);
  });

  it('returns executive compensation for 990 filings', async () => {
    const ctx = createMockContext();
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    const ec = result.filings[0]!.executive_compensation;
    expect(ec).not.toBeNull();
    expect(ec!.field_name).toBe('compnsatncurrofcr');
    expect(ec!.amount).toBe(250_000);
    expect(ec!.form_type).toBe('990');
  });

  it('returns null program_expense_ratio for 990-PF filings', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawFilingsResponse(),
        filings_with_data: [
          {
            tax_prd: 202212,
            tax_prd_yr: 2022,
            formtype: 2, // 990-PF
            pdf_url: null,
            totrevenue: 10_000_000,
            totfuncexpns: 8_000_000,
            compofficers: 500_000,
          },
        ],
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext();
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings[0]!.program_expense_ratio).toBeNull();
    expect(result.filings[0]!.executive_compensation!.field_name).toBe('compofficers');
    expect(result.filings[0]!.form_type).toBe('990-PF');
  });

  it('throws no_filings with correct code and reason for orgs with empty filings arrays', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawFilingsResponse(),
        filings_with_data: [],
        filings_without_data: [],
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    await expect(nonprofitGetFilings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_filings' },
    });
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

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 100000001 });
    await expect(nonprofitGetFilings.handler(input, ctx)).rejects.toMatchObject({
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

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    await expect(nonprofitGetFilings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('returns filings_pdf_only from filings_without_data', async () => {
    const ctx = createMockContext();
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings_pdf_only).toHaveLength(1);
    expect(result.filings_pdf_only[0]!.tax_prd_yr).toBe(2018);
    expect(result.filings_pdf_only[0]!.pdf_url).toBe('https://example.com/990-2018.pdf');
  });

  it('handles sparse upstream data (null pdf_url)', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawFilingsResponse(),
        filings_with_data: [
          {
            tax_prd: 202212,
            tax_prd_yr: 2022,
            formtype: 0,
            pdf_url: null, // PDF not yet available
            totrevenue: 3_000_000,
          },
        ],
        filings_without_data: [],
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext();
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings[0]!.pdf_url).toBeNull();
  });

  it('format renders tax year and PDF link', () => {
    const output = {
      ein: 530196605,
      name: 'The Red Cross',
      filings: [
        {
          tax_prd_yr: 2022,
          tax_prd: 202212,
          form_type: '990' as const,
          pdf_url: 'https://example.com/990.pdf',
          updated: '2024-01-15T00:00:00Z',
          total_revenue: 3_000_000,
          total_expenses: 2_800_000,
          total_assets: 5_000_000,
          total_liabilities: 1_000_000,
          net_assets: 4_000_000,
          contributions_and_grants: 2_500_000,
          program_service_revenue: 400_000,
          investment_income: 100_000,
          program_expense_ratio: {
            ratio: 0.464,
            program_expenses: 1_300_000,
            total_expenses: 2_800_000,
            management_compensation: 250_000,
            other_salaries: 1_200_000,
            fundraising_expenses: 50_000,
            note: 'Program expenses = total − officer/director comp − other salaries/wages − professional fundraising.',
          },
          executive_compensation: {
            amount: 250_000,
            field_name: 'compnsatncurrofcr',
            form_type: '990',
            note: '990/990-EZ: total compensation of current officers.',
          },
        },
      ],
      filings_pdf_only: [],
      total_filings_with_data: 1,
      total_filings_pdf_only: 0,
      data_source: 'ProPublica Nonprofit Explorer',
      propublica_url: 'https://projects.propublica.org/nonprofits/organizations/530196605',
    };
    const blocks = nonprofitGetFilings.format!(output);
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    expect(text).toContain('FY 2022');
    expect(text).toContain('https://example.com/990.pdf');
    expect(text).toContain('202212');
    expect(text).toContain('compnsatncurrofcr');
  });
});
