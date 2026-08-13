/**
 * @fileoverview Tests for the nonprofit_search tool.
 * @module tests/tools/nonprofit-search.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitSearch } from '@/mcp-server/tools/definitions/nonprofit-search.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

// Minimal raw search response mirroring the upstream shape
const makeRawResponse = (orgs: object[] = [], overrides: object = {}) => ({
  total_results: orgs.length,
  num_pages: 1,
  cur_page: 0,
  per_page: 25,
  page_offset: 0,
  organizations: orgs,
  data_source: 'ProPublica Nonprofit Explorer',
  ...overrides,
});

const sampleOrg = {
  ein: 530196605,
  strein: '53-0196605',
  name: 'The Red Cross',
  sub_name: null,
  city: 'Washington',
  state: 'DC',
  ntee_code: 'P20',
  subseccd: 3,
  score: 100,
};

/** Install a mocked service whose `search` resolves the given raw response. */
const mockSearch = (raw: object) => {
  const search = vi.fn().mockResolvedValue(raw);
  vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
    search,
    getOrganization: vi.fn(),
  } as unknown as svcModule.NonprofitExplorerService);
  return search;
};

describe('nonprofitSearch', () => {
  beforeEach(() => {
    mockSearch(makeRawResponse([sampleOrg]));
  });

  it('returns mapped organizations on a successful search', async () => {
    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'red cross', page: 0 });
    const result = await nonprofitSearch.handler(input, ctx);

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]!.ein).toBe(530196605);
    expect(result.organizations[0]!.strein).toBe('53-0196605');
    expect(result.organizations[0]!.name).toBe('The Red Cross');
    expect(result.active_filters.query).toBe('red cross');
    expect(result.active_filters.state).toBeNull();
  });

  it('surfaces upstream per_page and page_offset', async () => {
    mockSearch(makeRawResponse([sampleOrg], { cur_page: 2, page_offset: 50, total_results: 60 }));

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'red cross', page: 2 });
    const result = await nonprofitSearch.handler(input, ctx);

    expect(result.per_page).toBe(25);
    expect(result.page_offset).toBe(50);
  });

  it('returns a zero-match search as a success with an explanatory notice', async () => {
    mockSearch(makeRawResponse([], { num_pages: 0, total_results: 0 }));

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'xyzzy_no_match', page: 0 });
    const result = await nonprofitSearch.handler(input, ctx);

    expect(result.organizations).toEqual([]);
    expect(result.total_results).toBe(0);
    expect(getEnrichment(ctx).notice).toContain('No organizations matched');
  });

  it('returns an exhausted page as a success naming the last valid page', async () => {
    mockSearch(
      makeRawResponse([], {
        cur_page: 245,
        num_pages: 245,
        page_offset: 6125,
        total_results: 6111,
      }),
    );

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'hospital', page: 245 });
    const result = await nonprofitSearch.handler(input, ctx);

    expect(result.organizations).toEqual([]);
    expect(result.total_results).toBe(6111);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('past the end');
    expect(notice).toContain('244');
    expect(notice).not.toContain('No organizations matched');
  });

  it('leaves a populated page free of a notice', async () => {
    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'red cross', page: 0 });
    await nonprofitSearch.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  /**
   * total_results saturates at ProPublica's 10,000-result ceiling. The caveat has to
   * reach structuredContent, not just the formatted text, or downstream arithmetic on
   * "10,000 matches" is silently wrong with nothing in the payload saying so.
   */
  it('carries the result-cap caveat on a populated page at the ceiling', async () => {
    mockSearch(makeRawResponse([sampleOrg], { num_pages: 400, total_results: 10_000 }));

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'inc', page: 0 });
    const result = await nonprofitSearch.handler(input, ctx);

    expect(result.total_results).toBe(10_000);
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('ceiling');
    expect(notice).toContain('10,000');
    expect(notice).not.toContain('past the end');
  });

  it('emits a single notice carrying both the cap and the past-the-end facts', async () => {
    mockSearch(
      makeRawResponse([], {
        cur_page: 400,
        num_pages: 400,
        page_offset: 9999,
        total_results: 10_000,
      }),
    );

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'inc', page: 400 });
    await nonprofitSearch.handler(input, ctx);

    // ctx.enrich.notice is last-wins — two calls would drop the first fact entirely.
    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('past the end');
    expect(notice).toContain('399');
    expect(notice).toContain('ceiling');
  });

  it('emits no cap notice below the ceiling', async () => {
    mockSearch(makeRawResponse([sampleOrg], { num_pages: 400, total_results: 9_999 }));

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'inc', page: 0 });
    await nonprofitSearch.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('phrases a single-page result set without "1 pages" or a 0–0 range', async () => {
    mockSearch(
      makeRawResponse([], { cur_page: 1, num_pages: 1, page_offset: 25, total_results: 3 }),
    );

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'obscure org', page: 1 });
    await nonprofitSearch.handler(input, ctx);

    const notice = String(getEnrichment(ctx).notice);
    expect(notice).toContain('1 page');
    expect(notice).not.toContain('1 pages');
    expect(notice).not.toContain('0–0');
    expect(notice).toContain('page 0');
  });

  it('propagates upstream_error when service throws serviceUnavailable', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi
        .fn()
        .mockRejectedValue(
          serviceUnavailable('ProPublica API unreachable', { reason: 'upstream_error' }),
        ),
      getOrganization: vi.fn(),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'test', page: 0 });
    await expect(nonprofitSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('echoes active filters in output', async () => {
    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({
      query: 'hospitals',
      state: 'WA',
      ntee_category: '4',
      subsection_code: '3',
      page: 0,
    });
    const result = await nonprofitSearch.handler(input, ctx);
    expect(result.active_filters.state).toBe('WA');
    expect(result.active_filters.ntee_category).toBe('4');
    expect(result.active_filters.subsection_code).toBe('3');
  });

  it.each(['wa', 'Wa', 'wA', 'WA'])(
    'normalizes state "%s" to WA before the request',
    async (state) => {
      const search = mockSearch(makeRawResponse([sampleOrg]));

      const ctx = createMockContext({ errors: nonprofitSearch.errors });
      const input = nonprofitSearch.input.parse({ query: 'food', state, page: 0 });
      const result = await nonprofitSearch.handler(input, ctx);

      expect(search).toHaveBeenCalledWith(expect.objectContaining({ state: 'WA' }), ctx);
      expect(result.active_filters.state).toBe('WA');
    },
  );

  it('throws invalid_state for a well-formed code that is not a real postal code', async () => {
    const search = mockSearch(makeRawResponse([sampleOrg]));
    // Compared against the contract rather than a literal, so a reword can't drift.
    const declared = nonprofitSearch.errors?.find((e) => e.reason === 'invalid_state')?.recovery;
    expect(declared).toBeTypeOf('string');

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'food', state: 'XX', page: 0 });
    await expect(nonprofitSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_state', recovery: { hint: declared } },
    });
    // The request must never leave the process — an unfiltered national answer is the bug.
    expect(search).not.toHaveBeenCalled();
  });

  it('format renders EIN, org name, and the page window', () => {
    const output = {
      total_results: 1,
      num_pages: 1,
      cur_page: 0,
      per_page: 25,
      page_offset: 0,
      organizations: [
        {
          ein: 530196605,
          strein: '53-0196605',
          name: 'The Red Cross',
          sub_name: null,
          city: 'Washington',
          state: 'DC',
          ntee_code: 'P20',
          subseccd: 3,
          score: 100,
        },
      ],
      active_filters: {
        query: 'red cross',
        state: null,
        ntee_category: null,
        subsection_code: null,
      },
      data_source: 'ProPublica Nonprofit Explorer',
    };
    const blocks = nonprofitSearch.format!(output);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block?.type).toBe('text');
    const text = block?.type === 'text' ? block.text : '';
    expect(text).toContain('The Red Cross');
    expect(text).toContain('53-0196605');
    expect(text).toContain('530196605');
    expect(text).toContain('red cross');
    expect(text).toContain('25 per page');
    expect(text).toContain('offset 0');
  });

  it('format renders an empty page without inventing organizations', () => {
    const output = {
      total_results: 6111,
      num_pages: 245,
      cur_page: 245,
      per_page: 25,
      page_offset: 6125,
      organizations: [],
      active_filters: {
        query: 'hospital',
        state: null,
        ntee_category: null,
        subsection_code: null,
      },
      data_source: 'ProPublica Nonprofit Explorer',
    };
    const blocks = nonprofitSearch.format!(output);
    const block = blocks[0];
    const text = block?.type === 'text' ? block.text : '';
    expect(text).toContain('6,111');
    expect(text).toContain('offset 6125');
    expect(text).not.toContain('## ');
    // The page line must not read as a bare contradiction before the trailer explains it.
    expect(text).toMatch(/Page 245 of 245 pages — past the end/);
    expect(text).toContain('244');
  });

  it('format does not repeat the cap caveat that the notice already carries', () => {
    const output = {
      total_results: 10_000,
      num_pages: 400,
      cur_page: 0,
      per_page: 25,
      page_offset: 0,
      organizations: [],
      active_filters: {
        query: 'inc',
        state: null,
        ntee_category: null,
        subsection_code: null,
      },
      data_source: 'ProPublica Nonprofit Explorer',
    };
    const blocks = nonprofitSearch.format!(output);
    const block = blocks[0];
    const text = block?.type === 'text' ? block.text : '';
    expect(text).toContain('10,000');
    expect(text).not.toContain('API cap reached');
  });

  /**
   * A nullable field present in structuredContent but dropped from content[] leaves a
   * content-only client unable to tell "not applied" from "never part of the response".
   */
  it('format renders null active filters as not applied', () => {
    const output = {
      total_results: 1,
      num_pages: 1,
      cur_page: 0,
      per_page: 25,
      page_offset: 0,
      organizations: [],
      active_filters: {
        query: 'red cross',
        state: null,
        ntee_category: null,
        subsection_code: null,
      },
      data_source: 'ProPublica Nonprofit Explorer',
    };
    const blocks = nonprofitSearch.format!(output);
    const block = blocks[0];
    const text = block?.type === 'text' ? block.text : '';

    expect(text).toMatch(/\*\*Filters:\*\*/);
    expect(text).toContain('state=Not applied');
    expect(text).toContain('ntee=Not applied');
    expect(text).toContain('501(c)=Not applied');
  });

  it('format renders a sparse organization row instead of dropping its null fields', () => {
    const output = {
      total_results: 1,
      num_pages: 1,
      cur_page: 0,
      per_page: 25,
      page_offset: 0,
      organizations: [
        {
          ein: 371740468,
          strein: '37-1740468',
          name: 'Seven Non Profit Corporation',
          sub_name: null,
          city: null,
          state: null,
          ntee_code: null,
          subseccd: null,
          score: 42,
        },
      ],
      active_filters: {
        query: 'seven',
        state: 'WA',
        ntee_category: '4',
        subsection_code: '3',
      },
      data_source: 'ProPublica Nonprofit Explorer',
    };
    const blocks = nonprofitSearch.format!(output);
    const block = blocks[0];
    const text = block?.type === 'text' ? block.text : '';

    expect(text).toContain('**City:** Not on record');
    expect(text).toContain('**State:** Not on record');
    expect(text).toContain('**NTEE Code:** Not classified');
    expect(text).toContain('**501(c):** Not classified');
    expect(text).toContain('**Name with Secondary Line:** Not on record');
    // Applied filters still render their values, not the null label.
    expect(text).toContain('state=WA');
  });

  it('format writes "1 page" rather than "1 pages" for a single-page result set', () => {
    const output = {
      total_results: 3,
      num_pages: 1,
      cur_page: 0,
      per_page: 25,
      page_offset: 0,
      organizations: [],
      active_filters: {
        query: 'obscure org',
        state: null,
        ntee_category: null,
        subsection_code: null,
      },
      data_source: 'ProPublica Nonprofit Explorer',
    };
    const blocks = nonprofitSearch.format!(output);
    const block = blocks[0];
    const text = block?.type === 'text' ? block.text : '';
    expect(text).toContain('1 page');
    expect(text).not.toContain('1 pages');
  });
});
