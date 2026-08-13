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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nonprofitGetFilings } from '@/mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import { nonprofitGetOrganization } from '@/mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import { nonprofitSearch } from '@/mcp-server/tools/definitions/nonprofit-search.tool.js';
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
    const result = await runToolContract(nonprofitSearch, { query: 'food', state: 'wa' });

    expect(new URL(http.calls[0]!.request.url).searchParams.get('state[id]')).toBe('WA');
    expect(result.structuredContent).toMatchObject({ total_results: 220 });
  });

  it('uppercases a title-case state so the filter is actually applied', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearch, { query: 'food', state: 'Wa' });

    expect(new URL(http.calls[0]!.request.url).searchParams.get('state[id]')).toBe('WA');
    expect(result.structuredContent).toMatchObject({ total_results: 220 });
  });

  it('echoes the normalized state in active_filters, not the raw input', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearch, { query: 'food', state: 'wa' });

    expect(result.structuredContent).toMatchObject({ active_filters: { state: 'WA' } });
  });

  it('rejects an uppercase-but-nonexistent code instead of returning unfiltered results', async () => {
    routeStateFilter();
    const result = await runToolContract(nonprofitSearch, { query: 'food', state: 'XX' });

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
    const result = await runToolContract(nonprofitSearch, { query: 'food', state: 'XX' });

    const declared = declaredRecovery(nonprofitSearch, 'invalid_state');
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
      const result = await runToolContract(nonprofitSearch, { query: 'food', state });
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
    await runToolContract(nonprofitSearch, {
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
    const result = await runToolContract(nonprofitSearch, { query: 'zzzznomatch2026' });

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
    const result = await runToolContract(nonprofitSearch, { page: 245, query: 'hospital' });

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
    const result = await runToolContract(nonprofitSearch, { page: 399, query: 'hospital' });

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
    const result = await runToolContract(nonprofitSearch, { page: 245, query: 'hospital' });

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
    const result = await runToolContract(nonprofitSearch, { query: 'inc' });

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
    const result = await runToolContract(nonprofitSearch, { page: 400, query: 'hospital' });

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
    const result = await runToolContract(nonprofitSearch, { page: 400, query: 'hospital' });

    const declared = declaredRecovery(nonprofitSearch, 'pagination_ceiling');
    expect(result.structuredContent).toMatchObject({
      error: { data: { recovery: { hint: declared } } },
    });
    expect((result.content[0] as { text: string }).text).toContain(`Recovery: ${declared}`);
  });

  it('surfaces per_page and page_offset on a populated page', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(populatedPage) });
    const result = await runToolContract(nonprofitSearch, { query: 'hospital' });

    expect(result.structuredContent).toMatchObject({ page_offset: 0, per_page: 25 });
    const rendered = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(rendered).toContain('25');
  });

  it('leaves a populated page free of an empty-result notice', async () => {
    http.route({ match: SEARCH_URL, respond: () => Response.json(populatedPage) });
    const result = await runToolContract(nonprofitSearch, { query: 'hospital' });

    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
  });

  it('treats a non-pagination HTTP 400 as an upstream error, not a page boundary', async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json({ error: 'Something else went wrong' }, { status: 400 }),
    });
    const result = await runToolContract(nonprofitSearch, { query: 'hospital' });

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
   * `ctx.recoveryFor` is rebuilt per invocation from the calling tool's own contract, so
   * each tool must receive its own declared hint from the same service throw site.
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

  it("attaches nonprofit_search's own upstream_error recovery hint", async () => {
    http.route({
      match: SEARCH_URL,
      respond: () => Response.json({ error: 'boom' }, { status: 503 }),
    });
    const result = await runToolContract(nonprofitSearch, { query: 'hospital' });

    const declared = declaredRecovery(nonprofitSearch, 'upstream_error');
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
