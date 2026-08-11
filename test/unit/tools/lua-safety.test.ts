/**
 * The regression guard for this project's central safety claim.
 *
 * Every Lua constant must be a literal with no interpolation. If someone later
 * writes `const X_LUA = \`... ${value} ...\`` this test fails, which is the
 * whole point: the guarantee is enforced by the build rather than by reviewers
 * remembering the rule.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = new URL('../../../src/', import.meta.url).pathname;

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    })
  );
  return files.flat();
}

/** Matches `const NAME_LUA = \`...\`;` and captures the template body. */
const LUA_CONSTANT_PATTERN = /const\s+([A-Z0-9_]*LUA)\s*=\s*`([\s\S]*?)`/g;

describe('Lua source constants', () => {
  it('exist, so the pattern below is actually testing something', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const bodies = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
    const matches = bodies.flatMap((body) => [...body.matchAll(LUA_CONSTANT_PATTERN)]);
    expect(matches.length).toBeGreaterThan(5);
  });

  it('never interpolate anything', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const match of contents.matchAll(LUA_CONSTANT_PATTERN)) {
        const [, name = 'unknown', body = ''] = match;
        if (body.includes('${')) {
          offenders.push(`${file}: ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('are declared as module-level constants, never built at call time', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      // A Lua constant indented by horizontal whitespace sits inside a
      // function, which means it is rebuilt per call and could capture a
      // variable. Matching \s+ here would be wrong: it spans newlines, so a
      // blank line before a top-level constant would look like indentation.
      expect(contents).not.toMatch(/\n[ \t]+const\s+[A-Z0-9_]*LUA\s*=/);
    }
  });
});

describe('bridge.run call sites', () => {
  it('always pass a named constant as the program, never an expression', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      for (const match of contents.matchAll(/bridge\.run\(\s*([^,)\s]+)/g)) {
        const argument = match[1] ?? '';
        // Permitted: an identifier ending in LUA. Anything else (a template
        // literal, a concatenation, a function call) is a splicing risk.
        if (!/^[A-Z0-9_]*LUA$/.test(argument)) {
          offenders.push(`${file}: bridge.run(${argument}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
