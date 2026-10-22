/**
 * @fileoverview Tests for NonprofitExplorerService against a mocked ProPublica upstream.
 * The tool tests mock the service wholesale; this file drives the real service — directly
 * for wire/classification behavior, and through `runToolContract` where the assertion is
 * about what a client actually receives on both response surfaces.
 * @module tests/services/nonprofit-explorer/nonprofit-explorer-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createInMemoryStorage,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitGetFilings } from '@/mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import { nonprofitGetOrganization } from '@/mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import { nonprofitSearchOrganizations } from '@/mcp-server/tools/definitions/nonprofit-search-organizations.tool.js';
import {
  getNonprofitExplorerService,
  initNonprofitExplorerService,
} from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

const SEARCH_URL = /\/nonprofits\/api\/v2\/search\.json/;
const ORG_URL = /\/nonprofits\/api\/v2\/organizations\//;

const DATA_SOURCE = 'ProPublica Nonprofit Explorer, IRS Form 990 data.';

/** Upstream shape: an ordinary populated page (query "hospital", page 0). */
const populatedPage = {
  cur_page: 0,
  data_source: DATA_SOURCE,
  num_pages: 245,
  organizations: [
    {
      city: 'Seattle',
      ein: 911275815,
      name: 'Seattle Childrens Hospital',
      ntee_code: 'E220',
      score: 88,
      state: 'WA',
      strein: '91-1275815',
      sub_name: null,
      subseccd: 3,
    },
  ],
  page_offset: 0,
  per_page: 25,
  total_results: 6111,
};

/** Upstream shape: the first exhausted page (page === num_pages). HTTP 200, empty array. */
const firstExhaustedPage = {
  cur_page: 245,
  data_source: DATA_SOURCE,
  num_pages: 245,
  organizations: [],
  page_offset: 6125,
  per_page: 25,
  total_results: 6111,
};

/** Upstream shape: well past the last page but under the offset ceiling. HTTP 404, nonzero total. */
const farPastEndPage = {
  cur_page: 399,
  data_source: DATA_SOURCE,
  num_pages: 245,
  organizations: [],
  page_offset: 9975,
  per_page: 25,
  total_results: 6111,
};

/** Upstream shape: a genuine zero-match query. HTTP 404, zero counts. */
const zeroMatchPage = {
  cur_page: 0,
  data_source: DATA_SOURCE,
  num_pages: 0,
  organizations: [],
  page_offset: 0,
  per_page: 25,
  total_results: 0,
};

/** Upstream shape: page offset at/beyond the 10,000-result ceiling. HTTP 400, no pagination fields. */
const paginationCeilingBody = {
  api_version: 2,
  data_source: DATA_SOURCE,
  error: 'Pagination out of range',
};

/** Upstream shape: a real organization profile with one filing. */
const orgProfile = {
  data_source: DATA_SOURCE,
  filings_with_data: [
    {
      formtype: 0,
      pdf_url: 'https://example.com/990.pdf',
      tax_prd: 202212,
      tax_prd_yr: 2022,
      totfuncexpns: 2_800_000,
      totrevenue: 3_000_000,
    },
  ],
  filings_without_data: [],
  organization: {
    address: '430 17th St NW',
    city: 'Washington',
    ein: 530196605,
    id: 530196605,
    name: 'The Red Cross',
    state: 'DC',
    strein: '53-0196605',
  },
};

/**
 * The `recovery` text a definition declares for a reason. Assertions compare the wire
 * hint against this rather than a literal, so a contract reword can't drift from the tests.
 */
function declaredRecovery(
  definition: { errors?: readonly { readonly reason: string; readonly recovery: string }[] },
  reason: string,
): string {
  const entry = definition.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No '${reason}' entry declared on the tool contract.`);
  return entry.recovery;
}

let http: FetchMockHarness;

beforeEach(() => {
  initNonprofitExplorerService({} as AppConfig, createInMemoryStorage());
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('request lifecycle', () => {
  it('characterizes retries recovering after two upstream failures', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    http.route({
      match: ORG_URL,
      respond: () =>
        ++attempts < 3 ? Response.json({}, { status: 503 }) : Response.json(orgProfile),
    });
    const pending = getNonprofitExplorerService().getOrganization(530196605, createMockContext());
    await vi.runAllTimersAsync();
    expect((await pending).organization?.name).toBe('The Red Cross');
    expect(attempts).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['status', 'network', 'rejected', 'html', 'json'] as const)(
    'keeps %s failures private on both surfaces',
    async (kind) => {
      vi.useFakeTimers();
      http.route({
        match: SEARCH_URL,
        respond: () => {
          if (kind === 'network') throw new Error('PRIVATE QUERY SENTINEL https://private.invalid');
          if (kind === 'html') return new Response('<html>PRIVATE QUERY SENTINEL</html>');
          if (kind === 'json') return new Response('PRIVATE QUERY SENTINEL');
          return Response.json({}, { status: kind === 'status' ? 503 : 400 });
        },
      });
      const resultPromise = runToolContract(nonprofitSearchOrganizations, {
        query: 'PRIVATE QUERY SENTINEL',
      });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'upstream_error',
            recovery: { hint: declaredRecovery(nonprofitSearchOrganizations, 'upstream_error') },
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE QUERY SENTINEL');
      expect(JSON.stringify(result)).not.toContain('search.json');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('omits request URLs from service debug metadata', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(populatedPage) });
    const ctx = createMockContext();
    const debug = vi.spyOn(ctx.log, 'debug');
    await getNonprofitExplorerService().search({ query: 'PRIVATE QUERY SENTINEL', page: 0 }, ctx);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('PRIVATE QUERY SENTINEL');
    expect(JSON.stringify(debug.mock.calls)).not.toContain('search.json');
  });

  it.each(['pre', 'fetch', 'body'] as const)(
    'preserves %s caller cancellation identity',
    async (stage) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const reason = new DOMException('caller stopped', 'AbortError');
      if (stage === 'pre') controller.abort(reason);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const signal = init?.signal;
        if (stage === 'body') {
          const response = Response.json(orgProfile);
          vi.spyOn(response, 'text').mockImplementation(async () => {
            controller.abort(reason);
            throw signal?.reason;
          });
          return response;
        }
        controller.abort(reason);
        throw signal?.reason;
      });
      const pending = getNonprofitExplorerService()
        .getOrganization(530196605, createMockContext({ signal: controller.signal }))
        .catch((error) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toBe(reason);
      expect(fetchMock).toHaveBeenCalledTimes(stage === 'pre' ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('preserves cancellation during retry backoff without starting another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new DOMException('caller stopped during backoff', 'AbortError');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}, { status: 503 }));
    const pending = getNonprofitExplorerService()
      .getOrganization(530196605, createMockContext({ signal: controller.signal }))
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies attempt timeouts and bounds the complete retry exchange', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          }),
        ),
    );
    const pending = getNonprofitExplorerService()
      .getOrganization(530196605, createMockContext())
      .catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'timeout', retryAttempts: 4 },
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the last possible successful attempt within the existing retry envelope', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    let attempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          const attempt = ++attempts;
          setTimeout(
            () =>
              attempt < 4 ? reject(new Error('transient')) : resolve(Response.json(orgProfile)),
            14_999,
          );
        }),
    );
    const pending = getNonprofitExplorerService().getOrganization(530196605, createMockContext());
    await vi.runAllTimersAsync();
    expect((await pending).organization?.name).toBe('The Red Cross');
    expect(attempts).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([nonprofitSearchOrganizations, nonprofitGetOrganization, nonprofitGetFilings])(
    'renders %s deadline classification and recovery on both surfaces',
    async (definition) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(1);
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const pending = runToolContract(
        definition,
        definition === nonprofitSearchOrganizations ? { query: 'hospital' } : { ein: 530196605 },
      );
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          data: {
            reason: 'retry_deadline_exceeded',
            deadlineMs: 64_375,
            retryAttempts: 4,
            recovery: { hint: 'Wait a moment and retry the request.' },
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain('retry_deadline_exceeded');
      expect(JSON.stringify(result.content)).toContain('Wait a moment and retry the request.');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retains network causes internally and removes forwarding listeners after every failed attempt', async () => {
    vi.useFakeTimers();
    const cause = new Error('PRIVATE QUERY SENTINEL');
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);
    const pending = getNonprofitExplorerService()
      .getOrganization(530196605, createMockContext())
      .catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      message: 'Network error reaching ProPublica API. (failed after 4 attempts)',
      cause: { cause },
    });
    const forwarders = add.mock.calls.filter(
      ([, callback]) => typeof callback === 'function' && callback.name === 'forwardAbort',
    );
    expect(forwarders).toHaveLength(4);
    for (const [event, callback] of forwarders)
      expect(remove).toHaveBeenCalledWith(event, callback);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its forwarding listener after a successful body read', async () => {
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    http.route({ match: ORG_URL, respond: () => Response.json(orgProfile) });
    await getNonprofitExplorerService().getOrganization(530196605, createMockContext());
    const forwarders = add.mock.calls.filter(
      ([, callback]) => typeof callback === 'function' && callback.name === 'forwardAbort',
    );
    expect(forwarders).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith('abort', forwarders[0]![1]);
  });

  it('times out a stalled body read and renders the attempt timeout reason', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const response = Response.json(orgProfile);
      vi.spyOn(response, 'text').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      return response;
    });
    const pending = runToolContract(nonprofitGetOrganization, { ein: 530196605 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'timeout',
          retryAttempts: 4,
          recovery: { hint: 'Wait a moment and retry the request.' },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('reason timeout');
    expect(JSON.stringify(result.content)).toContain('Wait a moment and retry the request.');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('form-specific financial wire data', () => {
  it.each([0, 1, 2])(
    'retains reported zeros for formtype %i and ignores other forms fields',
    async (formtype) => {
      http.route({
        match: ORG_URL,
        respond: () =>
          Response.json({
            ...orgProfile,
            filings_with_data: [
              {
                formtype,
                tax_prd_yr: 2023,
                totnetassetend: 0,
                totnetassetsend: 0,
                tfundnworth: 0,
                totcntrbgfts: 0,
                totcntrbs: 0,
                grscontrgifts: 0,
                totprgmrevnue: 0,
                prgmservrev: 0,
                invstmntinc: 0,
                othrinvstinc: 0,
                intrstrvnue: 0,
                dividndsamt: 0,
                contrpdpbks: 0,
                distribamt: 0,
                fairmrktvalamt: 0,
                netinvstinc: 0,
              },
            ],
          }),
      });
      const result = await runToolContract(nonprofitGetFilings, { ein: 530196605 });
      expect(result.structuredContent).toMatchObject({
        filings: [
          {
            net_assets: 0,
            contributions_and_grants: 0,
            program_service_revenue: formtype === 2 ? null : 0,
            investment_income: 0,
            grants_paid: formtype === 2 ? 0 : null,
            distributable_amount: formtype === 2 ? 0 : null,
            fair_market_value_assets: formtype === 2 ? 0 : null,
            net_investment_income: formtype === 2 ? 0 : null,
          },
        ],
      });
      const profile = await runToolContract(nonprofitGetOrganization, { ein: 530196605 });
      expect(profile.structuredContent).toMatchObject({ latest_filing: { net_assets: 0 } });
      expect(JSON.stringify(profile.content)).toContain('**Net Assets:** $0');
      const text = JSON.stringify(result.content);
      expect(text).toContain('**Net Assets (EoY):** $0');
      expect(text).toContain('**Contributions & Grants:** $0');
      expect(text).toContain('**Investment Income:** $0');
      expect(text).toContain(
        formtype === 2
          ? '**Grants Paid (Part I line 25 column (a)):** $0'
          : '**Grants Paid (Part I line 25 column (a)):** Not applicable',
      );
    },
  );

  const ez = {
    formtype: 1,
    tax_prd_yr: 2023,
    totnetassetend: 101,
    tfundnworth: 102,
    totnetassetsend: 469055,
    totcntrbgfts: 103,
    grscontrgifts: 104,
    totcntrbs: 9405,
    totprgmrevnue: 105,
    prgmservrev: 43106,
    invstmntinc: 106,
    othrinvstinc: 9178,
  };
  const pf = {
    formtype: 2,
    tax_prd_yr: 2024,
    totnetassetend: 201,
    totnetassetsend: 202,
    tfundnworth: 70420596215,
    totcntrbgfts: 203,
    totcntrbs: 204,
    grscontrgifts: 17,
    totprgmrevnue: 205,
    prgmservrev: 206,
    invstmntinc: 207,
    othrinvstinc: 208,
    intrstrvnue: 2,
    dividndsamt: 3,
    contrpdpbks: 7200556970,
    distribamt: 159411117,
    fairmrktvalamt: 76951451400,
    netinvstinc: 3210658,
  };

  it('maps mixed-form history and the latest snapshot without cross-form substitutions', async () => {
    http.route({
      match: ORG_URL,
      respond: () =>
        Response.json({
          ...orgProfile,
          filings_with_data: [ez, ...orgProfile.filings_with_data, pf],
        }),
    });
    const filings = await runToolContract(nonprofitGetFilings, { ein: 530196605 });
    expect(filings.structuredContent).toMatchObject({
      filings: [
        {
          form_type: '990-PF',
          net_assets: 70420596215,
          contributions_and_grants: 17,
          program_service_revenue: null,
          investment_income: 5,
          grants_paid: 7200556970,
          distributable_amount: 159411117,
          fair_market_value_assets: 76951451400,
          net_investment_income: 3210658,
        },
        {
          form_type: '990-EZ',
          net_assets: 469055,
          contributions_and_grants: 9405,
          program_service_revenue: 43106,
          investment_income: 9178,
          grants_paid: null,
        },
        { form_type: '990', grants_paid: null },
      ],
    });
    const text = JSON.stringify(filings.content);
    for (const amount of [
      '70,420,596,215',
      '469,055',
      '9,405',
      '43,106',
      '9,178',
      '7,200,556,970',
      '159,411,117',
      '76,951,451,400',
      '3,210,658',
    ])
      expect(text).toContain(amount);
    expect(text).toContain('required');
    expect(text).toContain('savings interest');
    const profile = await runToolContract(nonprofitGetOrganization, { ein: 530196605 });
    expect(profile.structuredContent).toMatchObject({ latest_filing: { net_assets: 70420596215 } });
    expect(JSON.stringify(profile.content)).toContain('70,420,596,215');
  });

  it.each([
    { intrstrvnue: 0, dividndsamt: 0, expected: 0 },
    { intrstrvnue: 2, expected: null },
    { dividndsamt: 3, expected: null },
    { intrstrvnue: null, dividndsamt: 3, expected: null },
  ])('preserves sparse PF components $expected', async ({ expected, ...components }) => {
    http.route({
      match: ORG_URL,
      respond: () =>
        Response.json({
          ...orgProfile,
          filings_with_data: [{ formtype: 2, tax_prd_yr: 2023, ...components, contrpdpbks: 0 }],
        }),
    });
    const result = await runToolContract(nonprofitGetFilings, { ein: 530196605 });
    expect(result.structuredContent).toMatchObject({
      filings: [
        {
          investment_income: expected,
          grants_paid: 0,
          distributable_amount: null,
          fair_market_value_assets: null,
          net_investment_income: null,
        },
      ],
    });
    expect(JSON.stringify(result.content)).toContain(
      `**Investment Income:** ${expected === null ? 'Not extracted' : '$0'}`,
    );
  });

  it.each([
    [0, 0],
    [0, 2],
    [1, 0],
    [1, 2],
  ])('counts %i extracted and %i PDF-only filings', async (extracted, pdf) => {
    http.route({
      match: ORG_URL,
      respond: () =>
        Response.json({
          ...orgProfile,
          filings_with_data: extracted ? [ez] : [],
          filings_without_data: Array.from({ length: pdf }, () => ({ tax_prd_yr: 2020 })),
        }),
    });
    const result = await runToolContract(nonprofitGetOrganization, { ein: 530196605 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      filing_count: extracted,
      filing_count_pdf_only: pdf,
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(`**Filings with extracted data:** ${extracted}`);
    expect(text).toContain(`**PDF-only filings:** ${pdf}`);
    if (!extracted) expect(result.structuredContent).toMatchObject({ latest_filing: null });
    if (pdf) {
      expect(text).not.toContain('990N');
      if (!extracted) expect(text).toContain('nonprofit_get_filings');
    }
  });
});

describe('NonprofitExplorerService.search — state filter', () => {
  /**
   * ProPublica honors `state[id]` only on an exact uppercase match and silently answers
   * anything else with the unfiltered national set (HTTP 200). The two routes below
   * reproduce that: the uppercase-WA route is checked first, everything else falls
   * through to the national response.
   */
  const routeStateFilter = () => {
    http.route(
      {
        match: (request) => new URL(request.url).searchParams.get('state[id]') === 'WA',
        respond: () => Response.json({ ...populatedPage, total_results: 220, num_pages: 9 }),
      },
      {
        match: SEARCH_URL,
        respond: () => Response.json({ ...populatedPage, total_results: 6866, num_pages: 275 }),
      },
    );
  };

  it('sends an already-uppercase state code through unchanged', async () => {
    routeStateFilter();
    const ctx = createMockContext();
    const raw = await getNonprofitExplorerService().search(
      { page: 0, query: 'food', state: 'WA' },
      ctx,
    );

    expect(raw.total_results).toBe(220);
    expect(new URL(http.calls[0]!.request.url).searchParams.get('state[id]')).toBe('WA');
  });

  it('uppercases a lowercase state so the filter is actually applied', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearchOrganizations, {
      query: 'food',
      state: 'wa',
    });

    expect(new URL(http.calls[0]!.request.url).searchParams.get('state[id]')).toBe('WA');
    expect(result.structuredContent).toMatchObject({ total_results: 220 });
  });

  it('uppercases a title-case state so the filter is actually applied', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearchOrganizations, {
      query: 'food',
      state: 'Wa',
    });

    expect(new URL(http.calls[0]!.request.url).searchParams.get('state[id]')).toBe('WA');
    expect(result.structuredContent).toMatchObject({ total_results: 220 });
  });

  it('echoes the normalized state in active_filters, not the raw input', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearchOrganizations, {
      query: 'food',
      state: 'wa',
    });

    expect(result.structuredContent).toMatchObject({ active_filters: { state: 'WA' } });
  });

  it('rejects an uppercase-but-nonexistent code instead of returning unfiltered results', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearchOrganizations, {
      query: 'food',
      state: 'XX',
    });

    expect(http.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_state' },
      },
    });
  });

  it('carries a recovery hint for a rejected state on both response surfaces', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearchOrganizations, {
      query: 'food',
      state: 'XX',
    });

    const declared = declaredRecovery(nonprofitSearchOrganizations, 'invalid_state');
    expect(result.structuredContent).toMatchObject({
      error: { data: { recovery: { hint: declared } } },
    });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  });

  it('accepts territory and foreign-entity codes', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json(populatedPage),
    });
    for (const state of ['PR', 'GU', 'DC', 'ZZ', 'zz']) {
      const result = await runToolContract(nonprofitSearchOrganizations, { query: 'food', state });
      expect(result.isError).toBeFalsy();
    }
    expect(http.calls.map((c) => new URL(c.request.url).searchParams.get('state[id]'))).toEqual([
      'PR',
      'GU',
      'DC',
      'ZZ',
      'ZZ',
    ]);
  });

  it('leaves ntee_category and subsection_code filtering untouched', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(populatedPage) });
    await runToolContract(nonprofitSearchOrganizations, {
      ntee_category: '4',
      query: 'hospital',
      subsection_code: '3',
    });

    const params = new URL(http.calls[0]!.request.url).searchParams;
    expect(params.get('ntee[id]')).toBe('4');
    expect(params.get('c_code[id]')).toBe('3');
    expect(params.get('state[id]')).toBeNull();
  });
});

describe('NonprofitExplorerService.search — pagination boundaries', () => {
  it('returns a genuine zero-match as a success with an explanatory notice', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json(zeroMatchPage, { status: 404 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, {
      query: 'zzzznomatch2026',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      organizations: [],
      total_results: 0,
    });
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('No organizations matched');
    expect((result.content[0] as { text: string }).text).toContain('zzzznomatch2026');
  });

  it('returns the first exhausted page as a success naming the valid page range', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(firstExhaustedPage) });
    const result = await runToolContract(nonprofitSearchOrganizations, {
      page: 245,
      query: 'hospital',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cur_page: 245,
      num_pages: 245,
      organizations: [],
      page_offset: 6125,
      per_page: 25,
      total_results: 6111,
    });
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('244');
    expect(notice).not.toContain('No organizations matched');
  });

  it('returns an HTTP 404 page far past the end as a success, not a zero-match', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json(farPastEndPage, { status: 404 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, {
      page: 399,
      query: 'hospital',
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cur_page: 399,
      organizations: [],
      page_offset: 9975,
      total_results: 6111,
    });
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('244');
  });

  it('mirrors the empty-page notice into content[] for format()-only clients', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(firstExhaustedPage) });
    const result = await runToolContract(nonprofitSearchOrganizations, {
      page: 245,
      query: 'hospital',
    });

    const rendered = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(rendered).toContain('244');
  });

  /**
   * A bare `total_results: 10000` is a saturated ceiling, not a count. The marker has to
   * reach both surfaces — a structuredContent client doing arithmetic on it otherwise has
   * nothing in the payload telling it the number is a floor.
   */
  it('carries the result-cap caveat on both response surfaces', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json({ ...populatedPage, num_pages: 400, total_results: 10_000 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, { query: 'inc' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total_results: 10_000 });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('ceiling');

    const rendered = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(rendered).toContain('ceiling');
    // One source for the caveat — the old inline format() suffix would double it up.
    expect(rendered).not.toContain('API cap reached');
  });

  it('classifies the HTTP 400 offset ceiling as a non-retryable pagination error', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json(paginationCeilingBody, { status: 400 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, {
      page: 400,
      query: 'hospital',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { page: 400, reason: 'pagination_ceiling', retryable: false },
      },
    });
    // A deterministic input error must not burn the retry budget.
    expect(http.calls).toHaveLength(1);
  });

  it('carries a recovery hint for the pagination ceiling on both response surfaces', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json(paginationCeilingBody, { status: 400 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, {
      page: 400,
      query: 'hospital',
    });

    const declared = declaredRecovery(nonprofitSearchOrganizations, 'pagination_ceiling');
    expect(result.structuredContent).toMatchObject({
      error: { data: { recovery: { hint: declared } } },
    });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  });

  it('surfaces per_page and page_offset on a populated page', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(populatedPage) });
    const result = await runToolContract(nonprofitSearchOrganizations, { query: 'hospital' });

    expect(result.structuredContent).toMatchObject({ page_offset: 0, per_page: 25 });
    const rendered = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(rendered).toContain('25');
  });

  it('leaves a populated page free of an empty-result notice', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(populatedPage) });
    const result = await runToolContract(nonprofitSearchOrganizations, { query: 'hospital' });

    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('treats a non-pagination HTTP 400 as an upstream error, not a page boundary', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json({ error: 'Something else went wrong' }, { status: 400 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, { query: 'hospital' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error' },
      },
    });
  }, 15_000);
});

describe('NonprofitExplorerService.getOrganization — not-found patterns', () => {
  it('classifies HTTP 404 with an error body as not_found (pattern 1)', async () => {
    http.route({
      match: ORG_URL,
      respond: () => Response.json({ error: 'Organization not found' }, { status: 404 }),
    });
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });

    await expect(
      getNonprofitExplorerService().getOrganization(100000001, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { ein: 100000001, reason: 'not_found' },
    });
  });

  it('classifies HTTP 200 with id 0 as not_found (pattern 2)', async () => {
    http.route({
      match: ORG_URL,
      respond: () =>
        Response.json({ organization: { address: null, id: 0, name: 'Unknown Organization' } }),
    });
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });

    await expect(getNonprofitExplorerService().getOrganization(1, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('classifies HTTP 200 placeholder orgs as not_found (pattern 3)', async () => {
    http.route({
      match: ORG_URL,
      respond: () =>
        Response.json({
          organization: { address: null, id: 999999999, name: 'Unknown Organization' },
        }),
    });
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });

    await expect(
      getNonprofitExplorerService().getOrganization(999999999, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
  });

  it('returns the profile for a real organization', async () => {
    http.route({ match: ORG_URL, respond: () => Response.json(orgProfile) });
    const ctx = createMockContext({ errors: nonprofitGetOrganization.errors });

    const raw = await getNonprofitExplorerService().getOrganization(530196605, ctx);
    expect(raw.organization?.name).toBe('The Red Cross');
  });
});

describe('service-originated errors reaching the client', () => {
  /**
   * `getOrganization()` is shared by two tools whose `not_found` recovery text differs.
   * The service throws only `reason: 'not_found'`; the framework fills the hint from the
   * calling tool's own contract, so each tool must receive its own declared hint from the
   * same service throw site.
   */
  it.each([
    ['nonprofit_get_organization', nonprofitGetOrganization],
    ['nonprofit_get_filings', nonprofitGetFilings],
  ] as const)('attaches %s own not_found recovery hint', async (_name, definition) => {
    http.route({
      match: ORG_URL,
      respond: () => Response.json({ error: 'Organization not found' }, { status: 404 }),
    });
    const result = await runToolContract(definition, { ein: 100000001 });

    const declared = declaredRecovery(definition, 'not_found');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { ein: 100000001, reason: 'not_found', recovery: { hint: declared } },
      },
    });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  });

  it('attaches the upstream_error recovery hint when the API returns an HTML error page', async () => {
    http.route({
      match: ORG_URL,
      respond: () =>
        new Response('<!DOCTYPE html><html><body>500</body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const result = await runToolContract(nonprofitGetOrganization, { ein: 530196605 });

    const declared = declaredRecovery(nonprofitGetOrganization, 'upstream_error');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', recovery: { hint: declared } },
      },
    });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  }, 15_000);

  it('attaches the upstream_error recovery hint on an unparseable body', async () => {
    http.route({
      match: ORG_URL,
      respond: () => new Response('not json at all', { headers: { 'content-type': 'text/plain' } }),
    });
    const result = await runToolContract(nonprofitGetOrganization, { ein: 530196605 });

    const declared = declaredRecovery(nonprofitGetOrganization, 'upstream_error');
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_error', recovery: { hint: declared } } },
    });
  }, 15_000);

  it('attaches the upstream_error recovery hint on an unexpected upstream status', async () => {
    http.route({
      match: ORG_URL,
      respond: () => Response.json({ error: 'boom' }, { status: 503 }),
    });
    const result = await runToolContract(nonprofitGetOrganization, { ein: 530196605 });

    const declared = declaredRecovery(nonprofitGetOrganization, 'upstream_error');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', recovery: { hint: declared }, statusCode: 503 },
      },
    });
  }, 15_000);

  it("attaches nonprofit_search_organizations's own upstream_error recovery hint", async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json({ error: 'boom' }, { status: 503 }),
    });
    const result = await runToolContract(nonprofitSearchOrganizations, { query: 'hospital' });

    const declared = declaredRecovery(nonprofitSearchOrganizations, 'upstream_error');
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_error', recovery: { hint: declared } } },
    });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  }, 15_000);

  /**
   * The org resolved; it simply has no 990 on record. A client branching on `isError`
   * must be able to tell that from a failed lookup, so the explanation rides the
   * success path on both surfaces rather than an error envelope.
   */
  it('returns an org with no filings as a success on both response surfaces', async () => {
    http.route({
      match: ORG_URL,
      respond: () =>
        Response.json({
          ...orgProfile,
          filings_with_data: [],
          filings_without_data: [],
        }),
    });
    const result = await runToolContract(nonprofitGetFilings, { ein: 530196605 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      filings: [],
      filings_pdf_only: [],
      name: 'The Red Cross',
      total_filings_with_data: 0,
    });

    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('990N');

    const rendered = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(rendered).toContain('990N');
  });

  it('still throws not_found for an EIN that resolves to no organization', async () => {
    http.route({
      match: ORG_URL,
      respond: () => Response.json({ error: 'Organization not found' }, { status: 404 }),
    });
    const result = await runToolContract(nonprofitGetFilings, { ein: 100000001 });

    const declared = declaredRecovery(nonprofitGetFilings, 'not_found');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  });
});
