/**
 * The regression guard for this project's central safety claim.
 *
 * Every Lua constant must be a literal with no interpolation. If someone later
 * writes `const X_LUA = \`... ${value} ...\`` this test fails, which is the
 * whole point: the guarantee is enforced by the build rather than by reviewers
 * remembering the rule.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { SRC_ROOT, collectTypeScriptFiles } from './src-walker.js';

/**
 * Matches `const NAME_LUA = lua\`...\`;` and captures the template body. The
 * tag is optional in the pattern so an untagged constant is still inspected
 * rather than silently skipped, even though the type system now rejects one.
 */
const LUA_CONSTANT_PATTERN = /const\s+([A-Z0-9_]*LUA)\s*=\s*(?:lua)?`([\s\S]*?)`/g;

/**
 * Strips comments before scanning.
 *
 * Documentation legitimately shows what NOT to write, and src/bridge/lua.ts
 * does exactly that. Without this, the file explaining the rule fails the test
 * enforcing it, which would train people to weaken the test.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Lua source constants', () => {
  it('exist, so the pattern below is actually testing something', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const bodies = await Promise.all(
      files.map(async (file) => withoutComments(await readFile(file, 'utf8')))
    );
    const matches = bodies.flatMap((body) => [...body.matchAll(LUA_CONSTANT_PATTERN)]);
    expect(matches.length).toBeGreaterThan(5);
  });

  it('never interpolate anything', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = withoutComments(await readFile(file, 'utf8'));
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
      const contents = withoutComments(await readFile(file, 'utf8'));
      // A Lua constant indented by horizontal whitespace sits inside a
      // function, which means it is rebuilt per call and could capture a
      // variable. Matching \s+ here would be wrong: it spans newlines, so a
      // blank line before a top-level constant would look like indentation.
      expect(contents).not.toMatch(/\n[ \t]+const\s+[A-Z0-9_]*LUA\s*=/);
    }
  });
});

describe('the lua tag', () => {
  it('is used for every Lua constant, so the compiler sees them all', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const untagged: string[] = [];

    for (const file of files) {
      const contents = withoutComments(await readFile(file, 'utf8'));
      for (const match of contents.matchAll(LUA_CONSTANT_PATTERN)) {
        const [whole, name = 'unknown'] = match;
        if (!whole.includes('= lua`')) {
          untagged.push(`${file}: ${name}`);
        }
      }
    }

    expect(untagged).toEqual([]);
  });

  it('is never bypassed in src by the escape hatch', async () => {
    // unsafeLuaFromString exists for tests that build Lua deliberately. In
    // src it would defeat the point of the branded type, so it is banned here
    // rather than left to reviewer memory.
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      if (file.endsWith('lua.ts')) continue; // the definition itself
      const contents = withoutComments(await readFile(file, 'utf8'));
      if (/unsafeLuaFromString\s*\(/.test(contents)) offenders.push(file);
      if (/as\s+unknown\s+as\s+LuaProgram|as\s+LuaProgram/.test(contents)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

describe('bridge.run call sites', () => {
  it('always pass a named constant as the program, never an expression', async () => {
    const files = await collectTypeScriptFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const contents = withoutComments(await readFile(file, 'utf8'));
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
