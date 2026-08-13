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
  });
});
