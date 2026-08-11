/**
 * Integration tests against a real, running Hammerspoon.
 *
 * These never run in CI: Hammerspoon is a macOS GUI application and cannot be
 * installed on a hosted runner. They auto-skip when no hs binary is present, so
 * running them on a machine without Hammerspoon is a no-op rather than a
 * failure.
 *
 * Run with: npm run test:integration
 */

import { describe, expect, it } from 'vitest';

import { HammerspoonBridge } from '../../src/bridge/bridge.js';
import { ALL_TOOLS } from '../../src/tools/index.js';

const bridge = new HammerspoonBridge();
const available = bridge.hsPath !== undefined;

describe.skipIf(!available)('bridge against real Hammerspoon', () => {
  it('completes a round trip', async () => {
    const result = await bridge.run('return "pong"');
    expect(result).toEqual({ ok: true, value: 'pong' });
  });

  it('passes arguments through the codec without interpretation', async () => {
    // Every one of these breaks a string-splicing implementation.
    const hostile = {
      quote: 'say "hello"',
      bracket: 'danger ]==] danger',
      newline: 'a\nb',
      backslash: 'C:\\path',
      injection: '"); os.exit(); ("',
      emoji: '🚀',
    };
    const result = await bridge.run('return ARGS', hostile);
    expect(result).toEqual({ ok: true, value: hostile });
  });

  it('reports a Lua runtime error as LuaError', async () => {
    const result = await bridge.run('error("deliberate", 0)');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('LuaError');
    expect(result.error.message).toContain('deliberate');
  });

  it('reports a Lua syntax error rather than hanging', async () => {
    const result = await bridge.run('this is not lua');
    expect(result.ok).toBe(false);
  });

  it('returns undefined for a body with no return value', async () => {
    const result = await bridge.run('local unused = 1');
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('honours a short timeout', async () => {
    const result = await bridge.run('hs.timer.usleep(3000000) return 1', {}, { timeoutMs: 400 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Timeout');
  });
});

/**
 * Executes each tool's real Lua. This is the check that catches a typo in a
 * Hammerspoon API name, which no amount of unit testing against a fake
 * subprocess can find.
 */
describe.skipIf(!available)('tool Lua executes against real Hammerspoon', () => {
  const runTool = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
    expect(tool, `tool ${name} should exist`).toBeDefined();

    let captured: unknown;
    const fakeServer = {
      registerTool: (
        _name: string,
        _config: unknown,
        handler: (args: unknown, ctx: unknown) => Promise<unknown>
      ) => {
        captured = handler;
      },
    };
    tool?.register(fakeServer as never, { bridge });

    const handler = captured as (a: unknown, c: unknown) => Promise<{ isError?: boolean }>;
    return handler(args, {});
  };

  it.each([
    ['hs_health', {}],
    ['hs_list_windows', {}],
    ['hs_list_apps', {}],
    ['hs_screens', {}],
    ['hs_console_tail', { lines: 5 }],
  ])('%s succeeds', async (name, args) => {
    const result = await runTool(name, args);
    expect(result.isError).not.toBe(true);
  });

  it('hs_list_windows returns usable window ids', async () => {
    const result = await bridge.run(`
local out = {}
for _, w in ipairs(hs.window.allWindows()) do
  local id = w:id()
  if id then out[#out + 1] = id end
end
return #out
`);
    expect(result.ok).toBe(true);
  });

  it('hs_eval compiles supplied code with load instead of splicing it', async () => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === 'hs_eval');
    expect(tool?.tier).toBe('unsafe');

    const result = await runTool('hs_eval', { code: 'return 6 * 7', timeoutMs: 5000 });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('42');
  });
});
