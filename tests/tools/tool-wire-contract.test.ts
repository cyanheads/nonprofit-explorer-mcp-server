/**
 * @fileoverview Cross-tool guard on the `CallToolResult` envelope every definition puts
 * on the wire — strict argument rejection, and the success/failure split inside
 * `structuredContent`.
 * @module tests/tools/tool-wire-contract.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nonprofitGetFilings } from '@/mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import { nonprofitGetOrganization } from '@/mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import { nonprofitSearch } from '@/mcp-server/tools/definitions/nonprofit-search.tool.js';
import * as svcModule from '@/services/nonprofit-explorer/nonprofit-explorer-service.js';

/** The one text block a `structuredContent` failure mirrors into `content[]`. */
const renderText = (result: Awaited<ReturnType<typeof runToolContract>>): string =>
  (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');

/** The failure envelope a client reads off `structuredContent.error`. */
const errorEnvelope = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { error?: Record<string, unknown> } | undefined)?.error;

const emptySearchResponse = {
  total_results: 0,
  num_pages: 0,
  cur_page: 0,
  per_page: 25,
  page_offset: 0,
  organizations: [],
  data_source: 'ProPublica Nonprofit Explorer',
};

describe('tool wire contract', () => {
  beforeEach(() => {
    vi.spyOn(svcModule, 'getNonprofitExplorerService').mockReturnValue({
      search: vi.fn().mockResolvedValue(emptySearchResponse),
      getOrganization: vi.fn(),
    } as unknown as svcModule.NonprofitExplorerService);
  });

  /**
   * Tool inputs are strict: an argument key the schema does not declare is refused
   * by name rather than dropped. Silently stripping it turns a caller's typo into a
   * wrong answer they cannot detect — the value vanishes before the handler runs and
   * the call fails somewhere else. None of these tools proxies arbitrary upstream
   * query parameters, so none opts back out with `.passthrough()` / `.catchall()`.
   */
  describe.each([
    { tool: nonprofitSearch, valid: { query: 'red cross', page: 0 } },
    { tool: nonprofitGetOrganization, valid: { ein: 530196605 } },
    { tool: nonprofitGetFilings, valid: { ein: 530196605 } },
  ])('$tool.name', ({ tool, valid }) => {
    it('names the unrecognized argument key rather than stripping it', () => {
      const parsed = tool.input.safeParse({ ...valid, querry: 'red cross' });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({ code: 'unrecognized_keys', keys: ['querry'] }),
      );
    });

    it('rejects the call before the handler runs, on both response surfaces', async () => {
      const result = await runToolContract(tool, { ...valid, querry: 'red cross' } as never);

      /**
       * An argument rejection is `InvalidParams` (-32602), not the `ValidationError`
       * (-32007) a handler-thrown `ZodError` or an output-schema rejection classifies
       * as — the call never reached the handler, so the params are what was wrong.
       * The rejection carries the machine-readable `reason` a client branches on plus
       * a schema-derived hint naming the keys the tool does accept.
       */
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result)).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        message: expect.stringContaining('querry'),
        data: {
          reason: 'invalid_arguments',
          recovery: { hint: expect.stringContaining('querry') },
        },
      });

      /**
       * Containment, never a byte-exact match: the framework composes this block from
       * the message, a `Recovery:` line, and a `(reason …)` trailer, and each is free
       * to reword. What has to hold is that a `content[]`-only client can still see
       * which key was refused and branch on the same reason `structuredContent` carries.
       */
      const text = renderText(result);
      expect(text).toContain('querry');
      expect(text).toContain('reason invalid_arguments');
    });
  });

  /**
   * The advertised `outputSchema` declares the failure envelope alongside the success
   * fields, which is what lets a client validate `structuredContent` without first
   * branching on `isError`. The two branches have to stay disjoint for that to hold:
   * a success carries no `error`, and a failure carries no success field.
   */
  it('puts the success fields and the enrichment notice on one branch, with no error key', async () => {
    const result = await runToolContract(nonprofitSearch, { query: 'xyzzy_no_match', page: 0 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total_results: 0,
      organizations: [],
      notice: expect.stringContaining('No organizations matched'),
    });
    expect(result.structuredContent).not.toHaveProperty('error');
  });

  it('puts a declared failure on the error branch alone, carrying reason and recovery', async () => {
    // Compared against the contract rather than a literal, so a reword cannot drift.
    const declared = nonprofitSearch.errors?.find((e) => e.reason === 'invalid_state')?.recovery;
    expect(declared).toBeTypeOf('string');

    const result = await runToolContract(nonprofitSearch, {
      query: 'food',
      state: 'XX',
      page: 0,
    });

    expect(result.isError).toBe(true);
    expect(errorEnvelope(result)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_state', recovery: { hint: declared } },
    });
    // No half-populated success payload riding alongside the failure.
    for (const field of ['total_results', 'organizations', 'active_filters', 'data_source']) {
      expect(result.structuredContent).not.toHaveProperty(field);
    }

    /**
     * The declared reason reaches `content[]` too, not just `structuredContent` — a
     * client reading only the text block branches on the same term, and gets the
     * recovery hint verbatim rather than a paraphrase.
     */
    const text = renderText(result);
    expect(text).toContain(declared as string);
    expect(text).toContain('reason invalid_state');
  });
});
