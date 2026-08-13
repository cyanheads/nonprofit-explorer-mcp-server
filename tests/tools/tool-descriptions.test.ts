/**
 * @fileoverview Cross-tool guard on the LLM-facing description strings every definition renders.
 * @module tests/tools/tool-descriptions.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { nonprofitGetFilings } from '@/mcp-server/tools/definitions/nonprofit-get-filings.tool.js';
import { nonprofitGetOrganization } from '@/mcp-server/tools/definitions/nonprofit-get-organization.tool.js';
import { nonprofitSearch } from '@/mcp-server/tools/definitions/nonprofit-search.tool.js';

const tools = [nonprofitSearch, nonprofitGetOrganization, nonprofitGetFilings];

/** Every `description` the emitted JSON Schema carries, at any depth. */
function collectDescriptions(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDescriptions(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') out.push(value);
      else collectDescriptions(value, out);
    }
  }
}

/** Every string a client renders for one tool: description, field describes, error contract. */
function renderedStrings(tool: (typeof tools)[number]): string[] {
  const out: string[] = [tool.description ?? ''];
  const schemas = [tool.input, tool.output, tool.enrichment ? z.object(tool.enrichment) : null];
  for (const schema of schemas) {
    if (!schema) continue;
    collectDescriptions(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), out);
  }
  for (const entry of tool.errors ?? []) out.push(entry.when, entry.recovery);
  return out;
}

describe('tool definition descriptions', () => {
  /**
   * A `+`-concatenated description makes every fragment hand-carry its boundary
   * whitespace, so a dropped trailing space fuses two words in the schema the model
   * reads — with no lint error, no type error, and no visual tell in the source.
   * Nothing else asserts these strings: they are read only at tool-selection time,
   * which is why the fusion has to be caught here or not at all.
   */
  it.each([
    { defect: 'a word fused across a sentence boundary', pattern: /[a-z]{2}\.[A-Z]/ },
    { defect: 'a word fused across a comma', pattern: /[a-z],[A-Za-z]/ },
    { defect: 'a word fused across a colon', pattern: /[a-z]:[A-Za-z]/ },
    { defect: 'a word fused across a semicolon', pattern: /[a-z];[A-Za-z]/ },
    { defect: 'a doubled space', pattern: / {2}/ },
    { defect: 'leading or trailing whitespace', pattern: /^\s|\s$/ },
  ])('renders no description containing $defect', ({ pattern }) => {
    const offenders = tools.flatMap((tool) =>
      renderedStrings(tool)
        .filter((text) => pattern.test(text))
        .map((text) => `${tool.name}: ${text}`),
    );

    expect(offenders).toEqual([]);
  });

  /** Guards the checks above against passing vacuously on an empty collection. */
  it('collects a non-empty description for every tool and schema field', () => {
    for (const tool of tools) {
      const strings = renderedStrings(tool);
      expect(strings.length).toBeGreaterThan(0);
      expect(strings.filter((text) => text.trim() === '')).toEqual([]);
    }
  });
});
