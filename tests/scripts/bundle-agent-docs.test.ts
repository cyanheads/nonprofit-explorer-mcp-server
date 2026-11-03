/**
 * @fileoverview Preserve runtime skill support while stripping package-root agent docs from MCPB bundles.
 * @module tests/scripts/bundle-agent-docs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';

describe.each(['clean-mcpb', 'lint-packaging'])('%s agent-doc selector', (script) => {
  const scriptUrl = new URL(`../../scripts/${script}.ts`, import.meta.url);

  it('strips package-root author docs, including nested dependencies', async () => {
    const module = await import(scriptUrl.href);
    const selector = z.instanceof(RegExp).parse(module.AGENT_DOC_ENTRY);
    for (const entry of [
      'node_modules/example/skills/workflow/SKILL.md',
      'node_modules/@scope/example/framework-skills/add-tool/SKILL.md',
      'node_modules/example/.claude/skills/workflow/SKILL.md',
      'node_modules/example/.agents/skills/workflow/SKILL.md',
      'node_modules/example/SKILL.md',
      'node_modules/outer/node_modules/@scope/example/skills/workflow/SKILL.md',
    ]) {
      expect(selector.test(entry), entry).toBe(true);
    }
  });

  it('retains SDK skill runtime modules and the server published tree', async () => {
    const module = await import(scriptUrl.href);
    const selector = z.instanceof(RegExp).parse(module.AGENT_DOC_ENTRY);
    for (const entry of [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
      'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      'skills/nonprofit-research/SKILL.md',
    ]) {
      expect(selector.test(entry), entry).toBe(false);
    }
  });
});
