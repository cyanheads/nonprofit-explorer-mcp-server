/**
 * @fileoverview Tests for the nonprofit_search tool.
 * @module tests/tools/nonprofit-search.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitSearch } from '@/mcp-server/tools/definitions/nonprofit-search.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

// Minimal raw search response mirroring the upstream shape
const makeRawResponse = (orgs: object[] = []) => ({
  total_results: orgs.length,
  num_pages: 1,
  cur_page: 0,
  organizations: orgs,
  data_source: 'ProPublica Nonprofit Explorer',
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

describe('nonprofitSearch', () => {
  beforeEach(() => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn().mockResolvedValue(makeRawResponse([sampleOrg])),
      getOrganization: vi.fn(),
    } as unknown as svcModule.NonprofitExplorerService);
  });

  it('returns mapped organizations on a successful search', async () => {
    const ctx = createMockContext();
    const input = nonprofitSearch.input.parse({ query: 'red cross', page: 0 });
    const result = await nonprofitSearch.handler(input, ctx);

    expect(result.organizations).toHaveLength(1);
    expect(result.organizations[0]!.ein).toBe(530196605);
    expect(result.organizations[0]!.strein).toBe('53-0196605');
    expect(result.organizations[0]!.name).toBe('The Red Cross');
    expect(result.active_filters.query).toBe('red cross');
    expect(result.active_filters.state).toBeNull();
  });

  it('throws no_results with correct code and reason when service returns empty array', async () => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn().mockResolvedValue(makeRawResponse([])),
      getOrganization: vi.fn(),
    } as unknown as svcModule.NonprofitExplorerService);

    const ctx = createMockContext({ errors: nonprofitSearch.errors });
    const input = nonprofitSearch.input.parse({ query: 'xyzzy_no_match', page: 0 });
    await expect(nonprofitSearch.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_results' },
    });
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
    const ctx = createMockContext();
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

  it('format renders EIN and org name', () => {
    const output = {
      total_results: 1,
      num_pages: 1,
      cur_page: 0,
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
    const text = blocks[0]!.text;
    expect(text).toContain('The Red Cross');
    expect(text).toContain('53-0196605');
    expect(text).toContain('530196605');
    expect(text).toContain('red cross');
  });
});
