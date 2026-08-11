import { describe, expect, it } from 'vitest';

import { selectTools } from '../../src/server.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import type { RegisterableTool } from '../../src/tools/registry.js';

const names = (tools: readonly RegisterableTool[]): string[] => tools.map((tool) => tool.name);

describe('selectTools', () => {
  it('excludes every unsafe tool at the safe exposure', () => {
    const selected = selectTools('safe');
    expect(selected.every((tool) => tool.tier === 'safe')).toBe(true);
    expect(names(selected)).not.toContain('hs_eval');
  });

  it('includes unsafe tools only at the all exposure', () => {
    expect(names(selectTools('all'))).toContain('hs_eval');
  });

  it('keeps every safe tool visible at both exposures', () => {
    const safeNames = names(ALL_TOOLS.filter((tool) => tool.tier === 'safe'));
    expect(names(selectTools('safe'))).toEqual(safeNames);
    expect(names(selectTools('all'))).toEqual(expect.arrayContaining(safeNames));
  });

  it('preserves declaration order', () => {
    expect(names(selectTools('all'))).toEqual(names(ALL_TOOLS));
  });
});

describe('tool inventory', () => {
  it('has unique names', () => {
    const seen = names(ALL_TOOLS);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('names every tool in hs_snake_case, which is the wire format', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^hs_[a-z][a-z0-9_]*$/);
    }
  });

  it('assigns every tool a known tier', () => {
    for (const tool of ALL_TOOLS) {
      expect(['safe', 'unsafe']).toContain(tool.tier);
    }
  });

  // Arbitrary evaluation is the one capability the tier system exists to gate.
  // If another tool is ever marked unsafe, that is a deliberate decision that
  // should require updating this list.
  it('gates exactly the tools that are meant to be gated', () => {
    const gated = names(ALL_TOOLS.filter((tool) => tool.tier === 'unsafe'));
    expect(gated).toEqual(['hs_eval']);
  });

  it('never exposes a shell execution tool, at any tier', () => {
    // Agents already have shells. A Mac control server does not need to be one,
    // and shipping one would hand prompt injection a trivial escalation path.
    for (const tool of ALL_TOOLS) {
      expect(tool.name).not.toMatch(/exec|shell|command|spawn/);
    }
  });

  it('never exposes input synthesis or screen capture, which are exfiltration primitives', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).not.toMatch(/type|keystroke|click|screenshot|clipboard/);
    }
  });
});
