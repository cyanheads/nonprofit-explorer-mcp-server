/**
 * @fileoverview Tests for the nonprofit_get_filings tool.
 * @module tests/tools/nonprofit-get-filings.tool.test
 */

import { JsonRpcErrorCode, notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitGetFilings } from '@/mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

type FilingsOutput = Parameters<NonNullable<typeof nonprofitGetFilings.format>>[0];
type FilingsBlocks = ReturnType<NonNullable<typeof nonprofitGetFilings.format>>;
type Filing = FilingsOutput['filings'][number];

/** A fully-populated filing; overrides drive the sparse and form-type-specific cases. */
const makeFiling = (overrides: Partial<Filing> = {}): Filing => ({
  tax_prd_yr: 2022,
  tax_prd: 202212,
  form_type: '990',
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
  program_expense_ratio: null,
  executive_compensation: {
    amount: 250_000,
    field_name: 'compnsatncurrofcr',
    form_type: '990',
    note: '990/990-EZ: total compensation of current officers.',
  },
  ...overrides,
});

const makeFormatOutput = (overrides: Partial<FilingsOutput> = {}): FilingsOutput => ({
  ein: 530196605,
  name: 'The Red Cross',
  filings: [makeFiling()],
  filings_pdf_only: [],
  total_filings_with_data: 1,
  total_filings_pdf_only: 0,
  data_source: 'ProPublica Nonprofit Explorer',
  propublica_url: 'https://projects.propublica.org/nonprofits/organizations/530196605',
  ...overrides,
});

const renderText = (blocks: FilingsBlocks): string =>
  blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

/**
 * A schema-shaped output object built from the typed fixture, then widened so a
 * deliberately-invalid filing variant can be handed to `output.safeParse`.
 */
const outputWithFilingFields = (overrides: Record<string, unknown> = {}): unknown => {
  const base = makeFormatOutput() as unknown as Record<string, unknown>;
  const [filing] = base.filings as Record<string, unknown>[];
  return { ...base, filings: [{ ...filing, ...overrides }] };
};

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
    // formtype is numeric (0/1/2); formtype_str is the human-readable string field
    {
      tax_prd_yr: 2018,
      formtype: 0,
      formtype_str: '990',
      pdf_url: 'https://example.com/990-2018.pdf',
    },
  ],
  data_source: 'ProPublica Nonprofit Explorer',
});

/** Install a mocked service whose org response carries exactly one raw filing. */
const mockSingleFiling = (filing: object) => {
  vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
    search: vi.fn(),
    getOrganization: vi.fn().mockResolvedValue({
      ...makeRawFilingsResponse(),
      filings_with_data: [{ tax_prd: 202212, tax_prd_yr: 2022, pdf_url: null, ...filing }],
      filings_without_data: [],
    }),
  } as unknown as svcModule.NonprofitExplorerService);
};

describe('nonprofitGetFilings', () => {
  beforeEach(() => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue(makeRawFilingsResponse()),
    } as unknown as svcModule.NonprofitExplorerService);
  });

  it('returns filings sorted by tax year descending', async () => {
    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings).toHaveLength(2);
    expect(result.filings[0]!.tax_prd_yr).toBe(2022);
    expect(result.filings[1]!.tax_prd_yr).toBe(2021);
  });

  /**
   * ProPublica's extract carries no Form 990 Part IX column (B) program-service total,
   * so no arithmetic over the fields it does carry can produce a program-expense ratio.
   * Neither a full input set nor a sparse one may yield one.
   */
  it('returns a null program_expense_ratio for a 990 with every former deduction input present', async () => {
    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    // The fixture's newest filing carries compnsatncurrofcr, othrsalwages, and
    // profndraising — the fullest shape the API returns. Still not derivable.
    const latest = result.filings[0]!;
    expect(latest.total_expenses).toBe(2_800_000);
    expect(latest.program_expense_ratio).toBeNull();
  });

  it('returns a null program_expense_ratio for a sparse 990-EZ instead of reporting 100%', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawFilingsResponse(),
        filings_with_data: [
          {
            tax_prd: 201812,
            tax_prd_yr: 2018,
            formtype: 1, // 990-EZ — no Part IX functional-expense allocation exists
            pdf_url: 'https://example.com/990ez-2018.pdf',
            totrevenue: 90_000,
            totfuncexpns: 80_000,
            // compnsatncurrofcr / othrsalwages / profndraising absent entirely
          },
        ],
        filings_without_data: [],
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 371740468 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    // Treating the three missing inputs as zero previously reported a ratio of 1 (100%).
    expect(result.filings[0]!.form_type).toBe('990-EZ');
    expect(result.filings[0]!.program_expense_ratio).toBeNull();
  });

  it('keeps executive compensation and total expenses when the ratio is unavailable', async () => {
    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    const latest = result.filings[0]!;
    expect(latest.executive_compensation!.amount).toBe(250_000);
    expect(latest.total_expenses).toBe(2_800_000);
    expect(latest.pdf_url).toBe('https://example.com/990-2022.pdf');
  });

  it('advertises no derivable program-expense ratio in the tool description', () => {
    expect(nonprofitGetFilings.description).not.toMatch(/program.expense ratio/i);
  });

  it('returns executive compensation for 990 filings', async () => {
    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings[0]!.executive_compensation).toMatchObject({
      field_name: 'compnsatncurrofcr',
      amount: 250_000,
      form_type: '990',
    });
  });

  /**
   * The 990-PF branch and the 990/990-EZ fall-through are exhaustive: formtype 2 takes
   * the first, every other value — absent or unrecognized included — takes the second.
   * No filing shape leaves both inapplicable, so the block is always present and its
   * form type always agrees with the filing's own.
   */
  it.each([
    { formtype: 0, form_type: '990', field_name: 'compnsatncurrofcr', amount: 250_000 },
    { formtype: 1, form_type: '990-EZ', field_name: 'compnsatncurrofcr', amount: 250_000 },
    { formtype: 2, form_type: '990-PF', field_name: 'compofficers', amount: 500_000 },
    { formtype: undefined, form_type: '990', field_name: 'compnsatncurrofcr', amount: 250_000 },
    { formtype: 99, form_type: '990', field_name: 'compnsatncurrofcr', amount: 250_000 },
  ])(
    'builds an executive-compensation block for formtype $formtype',
    async ({ formtype, form_type, field_name, amount }) => {
      mockSingleFiling({ formtype, compnsatncurrofcr: 250_000, compofficers: 500_000 });

      const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
      const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
      const result = await nonprofitGetFilings.handler(input, ctx);

      expect(result.filings[0]!.form_type).toBe(form_type);
      expect(result.filings[0]!.executive_compensation).toMatchObject({
        form_type,
        field_name,
        amount,
      });
    },
  );

  /**
   * The output contract must not advertise a state the handler cannot reach. A null
   * block would read to a model as a real upstream condition it has to branch on.
   */
  it('rejects a null executive_compensation in the output contract', () => {
    expect(nonprofitGetFilings.output.safeParse(outputWithFilingFields()).success).toBe(true);
    expect(
      nonprofitGetFilings.output.safeParse(outputWithFilingFields({ executive_compensation: null }))
        .success,
    ).toBe(false);
  });

  /**
   * The same value is described one way at the filing level and must be described the
   * same way inside the block — a bare string would let a fourth form type through.
   */
  it('constrains executive_compensation.form_type to the filing-level form-type enum', () => {
    const withFormType = (form_type: string) =>
      outputWithFilingFields({
        executive_compensation: {
          amount: 250_000,
          field_name: 'compnsatncurrofcr',
          form_type,
          note: 'note',
        },
      });

    for (const formType of ['990', '990-EZ', '990-PF']) {
      expect(nonprofitGetFilings.output.safeParse(withFormType(formType)).success).toBe(true);
    }
    expect(nonprofitGetFilings.output.safeParse(withFormType('990-N')).success).toBe(false);
  });

  /**
   * buildExecComp reads exactly one of two upstream fields, so a bare string would
   * advertise a source the tool can never name.
   */
  it('constrains executive_compensation.field_name to the two source fields', () => {
    const withFieldName = (field_name: string) =>
      outputWithFilingFields({
        executive_compensation: {
          amount: 250_000,
          field_name,
          form_type: '990',
          note: 'note',
        },
      });

    for (const fieldName of ['compnsatncurrofcr', 'compofficers']) {
      expect(nonprofitGetFilings.output.safeParse(withFieldName(fieldName)).success).toBe(true);
    }
    expect(nonprofitGetFilings.output.safeParse(withFieldName('totfuncexpns')).success).toBe(false);
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

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings[0]!.program_expense_ratio).toBeNull();
    expect(result.filings[0]!.executive_compensation!.field_name).toBe('compofficers');
    expect(result.filings[0]!.form_type).toBe('990-PF');
  });

  /**
   * A resolved org with no 990 on record is a citable fact about it — the answer, not
   * the absence of one. It returns an empty list plus a notice, never an error.
   */
  it('returns an org with zero filings as a success carrying an explanatory notice', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn(),
      getOrganization: vi.fn().mockResolvedValue({
        ...makeRawFilingsResponse(),
        filings_with_data: [],
        filings_without_data: [],
      }),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 472325077 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings).toEqual([]);
    expect(result.filings_pdf_only).toEqual([]);
    expect(result.total_filings_with_data).toBe(0);
    expect(result.total_filings_pdf_only).toBe(0);
    // The org resolved — its name is in hand, which is why this is not a not-found.
    expect(result.name).toBe('The Red Cross');

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('990N');
    expect(notice).toContain('The Red Cross');
  });

  it('declares no no_filings reason, since nothing throws it', () => {
    expect(nonprofitGetFilings.errors?.map((e) => e.reason)).not.toContain('no_filings');
    expect(nonprofitGetFilings.errors?.map((e) => e.reason)).toContain('not_found');
  });

  it('leaves a populated filing list free of a notice', async () => {
    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    await nonprofitGetFilings.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
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

  it('returns filings_pdf_only from filings_without_data with correct string form_type_str', async () => {
    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings_pdf_only).toHaveLength(1);
    expect(result.filings_pdf_only[0]!.tax_prd_yr).toBe(2018);
    expect(result.filings_pdf_only[0]!.pdf_url).toBe('https://example.com/990-2018.pdf');
    // form_type_str must be the API's formtype_str string field ("990"), NOT the numeric formtype (0).
    // If this fails, the code read formtype (number) instead of formtype_str (string).
    expect(typeof result.filings_pdf_only[0]!.form_type_str).toBe('string');
    expect(result.filings_pdf_only[0]!.form_type_str).toBe('990');
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

    const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
    const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
    const result = await nonprofitGetFilings.handler(input, ctx);

    expect(result.filings[0]!.pdf_url).toBeNull();
  });

  it('format renders tax year and PDF link', () => {
    const blocks = nonprofitGetFilings.format!(makeFormatOutput());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = renderText(blocks);
    expect(text).toContain('FY 2022');
    expect(text).toContain('https://example.com/990.pdf');
    expect(text).toContain('202212');
    expect(text).toContain('compnsatncurrofcr');
  });

  it('format states why the program expense ratio is absent instead of dropping the section', () => {
    const text = renderText(nonprofitGetFilings.format!(makeFormatOutput()));

    expect(text).toContain('### Program Expense Ratio');
    expect(text).toMatch(/Not derivable/);
    expect(text).toContain('Part IX');
  });

  /**
   * A 990-PF genuinely has no revenue-breakdown fields; a 990 whose breakdown was not
   * extracted is a different fact. Collapsing both to one label loses that.
   */
  it('format distinguishes 990-PF inapplicable fields from unextracted ones', () => {
    const pf = renderText(
      nonprofitGetFilings.format!(
        makeFormatOutput({
          filings: [
            makeFiling({
              form_type: '990-PF',
              contributions_and_grants: null,
              program_service_revenue: null,
              investment_income: null,
              net_assets: null,
            }),
          ],
        }),
      ),
    );
    expect(pf).toContain('### Revenue Breakdown');
    expect(pf).toContain('**Contributions & Grants:** Not applicable for 990-PF');
    expect(pf).toContain('**Program Service Revenue:** Not applicable for 990-PF');
    expect(pf).toContain('**Investment Income:** Not applicable for 990-PF');
    // net_assets is a core financial field, not form-type-specific.
    expect(pf).toContain('**Net Assets (EoY):** Not extracted');

    const full990 = renderText(
      nonprofitGetFilings.format!(
        makeFormatOutput({
          filings: [makeFiling({ form_type: '990', contributions_and_grants: null })],
        }),
      ),
    );
    expect(full990).toContain('**Contributions & Grants:** Not extracted');
  });

  it('format renders unextracted core financials rather than omitting them', () => {
    const text = renderText(
      nonprofitGetFilings.format!(
        makeFormatOutput({
          filings: [
            makeFiling({
              total_revenue: null,
              total_expenses: null,
              total_assets: null,
              total_liabilities: null,
              net_assets: null,
              pdf_url: null,
              updated: null,
            }),
          ],
        }),
      ),
    );

    expect(text).toContain('**Revenue:** Not extracted');
    expect(text).toContain('**Expenses:** Not extracted');
    expect(text).toContain('**Assets (EoY):** Not extracted');
    expect(text).toContain('**Liabilities (EoY):** Not extracted');
    expect(text).toContain('**Net Assets (EoY):** Not extracted');
    expect(text).toContain('**Source 990 PDF:** Not yet available for this period');
    expect(text).toContain('**Last updated:** Not provided');
  });

  /**
   * Both consumption surfaces, driven through the handler rather than a hand-built
   * fixture: `structuredContent` clients read the returned block, `content[]` clients
   * read the rendered section. Every form type carries one.
   */
  it.each([
    { formtype: 0, form_type: '990', field_name: 'compnsatncurrofcr', amount: 250_000 },
    { formtype: 1, form_type: '990-EZ', field_name: 'compnsatncurrofcr', amount: 250_000 },
    { formtype: 2, form_type: '990-PF', field_name: 'compofficers', amount: 500_000 },
  ])(
    'renders executive compensation on both surfaces for a $form_type filing',
    async ({ formtype, form_type, field_name, amount }) => {
      mockSingleFiling({ formtype, compnsatncurrofcr: 250_000, compofficers: 500_000 });

      const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
      const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
      const result = await nonprofitGetFilings.handler(input, ctx);

      expect(result.filings[0]!.executive_compensation).toMatchObject({
        form_type,
        field_name,
        amount,
      });

      const text = renderText(nonprofitGetFilings.format!(result));
      expect(text).toContain(`### Executive Compensation (${form_type})`);
      expect(text).toContain(`**Total (${field_name}):** $${amount.toLocaleString()}`);
      // No form type renders the block as inapplicable — the field always exists.
      expect(text).not.toContain('no compensation field exists');
    },
  );

  /**
   * `amount` is the one genuinely nullable member: the extract omits `compofficers` on
   * a 990-PF and `compnsatncurrofcr` on a 990/990-EZ often enough to matter. The block
   * still renders, naming the absence rather than dropping the line.
   */
  it.each([
    { formtype: 0, form_type: '990', field_name: 'compnsatncurrofcr' },
    { formtype: 2, form_type: '990-PF', field_name: 'compofficers' },
  ])(
    'names an unreported executive-compensation amount on both surfaces for a $form_type filing',
    async ({ formtype, form_type, field_name }) => {
      // Neither compensation field present — the shape the extract returns when the
      // organization left the line blank.
      mockSingleFiling({ formtype, totrevenue: 3_000_000 });

      const ctx = createMockContext({ errors: nonprofitGetFilings.errors });
      const input = nonprofitGetFilings.input.parse({ ein: 530196605 });
      const result = await nonprofitGetFilings.handler(input, ctx);

      expect(result.filings[0]!.executive_compensation).toMatchObject({
        form_type,
        field_name,
        amount: null,
      });

      const text = renderText(nonprofitGetFilings.format!(result));
      expect(text).toContain(`### Executive Compensation (${form_type})`);
      expect(text).toContain(`**Total (${field_name}):** Not reported`);
    },
  );

  it('format renders an empty filing list without inventing filings', () => {
    const text = renderText(
      nonprofitGetFilings.format!(
        makeFormatOutput({
          filings: [],
          filings_pdf_only: [],
          total_filings_with_data: 0,
          total_filings_pdf_only: 0,
        }),
      ),
    );

    expect(text).toContain('The Red Cross');
    expect(text).toContain('**Filings with data:** 0');
    expect(text).toContain('No Form 990 with extracted financial data on record');
    expect(text).not.toContain('## FY');
  });
});
