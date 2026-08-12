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
import { lua } from '../../src/bridge/lua.js';
import { DocsIndex } from '../../src/docs/docs-index.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { applyFraction, LAYOUT_PRESETS } from '../../src/tools/safe/layout.js';

const bridge = new HammerspoonBridge();
const available = bridge.hsPath !== undefined;

describe.skipIf(!available)('bridge against real Hammerspoon', () => {
  it('completes a round trip', async () => {
    const result = await bridge.run(lua`return "pong"`);
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
    const result = await bridge.run(lua`return ARGS`, hostile);
    expect(result).toEqual({ ok: true, value: hostile });
  });

  it('reports a Lua runtime error as LuaError', async () => {
    const result = await bridge.run(lua`error("deliberate", 0)`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('LuaError');
    expect(result.error.message).toContain('deliberate');
  });

  it('reports a Lua syntax error rather than hanging', async () => {
    const result = await bridge.run(lua`this is not lua`);
    expect(result.ok).toBe(false);
  });

  it('returns undefined for a body with no return value', async () => {
    const result = await bridge.run(lua`local unused = 1`);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('honours a short timeout', async () => {
    // usleep blocks Hammerspoon's main thread, and killing our client does not
    // wake it. So keep the sleep barely longer than the timeout: a long one
    // leaves Hammerspoon unresponsive well after this test passes, and every
    // test that follows races it. That is what made hs_console_tail fail
    // intermittently, and only when run as part of the suite.
    const result = await bridge.run(lua`hs.timer.usleep(700000) return 1`, {}, { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Timeout');

    await waitForResponsive();
  });
});

/**
 * Blocks until Hammerspoon answers again.
 *
 * Any test that deliberately wedges the main thread has to clean up after
 * itself, otherwise it leaks its damage into whatever runs next as a confusing
 * timeout somewhere unrelated.
 */
async function waitForResponsive(attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await bridge.run(lua`return "awake"`, {}, { timeoutMs: 1000 });
    if (probe.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Hammerspoon did not become responsive again');
}

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
    tool?.register(fakeServer as never, { bridge, docs: new DocsIndex() });

    const handler = captured as (a: unknown, c: unknown) => Promise<{ isError?: boolean }>;
    return handler(args, {});
  };

  it.each([
    ['hs_health', {}],
    ['hs_list_windows', {}],
    ['hs_list_apps', {}],
    ['hs_screens', {}],
    ['hs_console_tail', { lines: 5 }],
    ['hs_machine_status', {}],
    ['hs_audio_devices', {}],
    ['hs_audio_volume', {}],
    ['hs_brightness', {}],
    ['hs_list_spaces', {}],
    ['hs_peripherals', {}],
    ['hs_wifi', {}],
    ['hs_keep_awake', {}],
    ['hs_list_shortcuts', {}],
  ])('%s succeeds', async (name, args) => {
    const result = await runTool(name, args);
    expect(result.isError).not.toBe(true);
  });

  // Read-modify-restore, so the suite leaves the machine as it found it.
  it('hs_audio_volume round-trips a change', async () => {
    const read = async (): Promise<{ volume: number }> =>
      JSON.parse(
        ((await runTool('hs_audio_volume', {})) as unknown as { content: { text: string }[] })
          .content[0]?.text ?? '{}'
      ) as { volume: number };

    const before = await read();
    try {
      await runTool('hs_audio_volume', { volume: 40, direction: 'output' });
      expect((await read()).volume).toBeCloseTo(40, 0);
    } finally {
      await runTool('hs_audio_volume', { volume: before.volume, direction: 'output' });
    }
    expect((await read()).volume).toBeCloseTo(before.volume, 0);
  });

  it('hs_audio_set_device lists the alternatives when nothing matches', async () => {
    const result = await runTool('hs_audio_set_device', { name: 'no-such-device-xyz' });
    expect(result.isError).toBe(true);
  });

  it('hs_goto_space recognises the space it is already on', async () => {
    const listed = (await runTool('hs_list_spaces', {})) as unknown as {
      content: { text: string }[];
    };
    const spaces = JSON.parse(listed.content[0]?.text ?? '[]') as {
      id: number;
      isCurrent: boolean;
    }[];
    const current = spaces.find((space) => space.isCurrent);
    expect(current).toBeDefined();
    if (!current) return;

    const result = (await runTool('hs_goto_space', {
      id: current.id,
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('alreadyThere');
  });

  it('hs_list_windows returns usable window ids', async () => {
    const result = await bridge.run(lua`
local out = {}
for _, w in ipairs(hs.window.allWindows()) do
  local id = w:id()
  if id then out[#out + 1] = id end
end
return #out
`);
    expect(result.ok).toBe(true);
  });

  /**
   * Proves the Lua placement matches the TypeScript reference implementation.
   * They are two copies of the same arithmetic, so without this they could
   * drift apart silently.
   *
   * The window is put back where it started, because a test should not
   * rearrange someone's desktop.
   */
  it('hs_window_layout places a window exactly where applyFraction predicts', async () => {
    const focused = await bridge.run(lua`
local w = hs.window.focusedWindow()
if not w then return nil end
local f = w:frame()
return { id = w:id(), frame = { x = f.x, y = f.y, w = f.w, h = f.h } }
`);
    expect(focused.ok).toBe(true);
    if (!focused.ok || focused.value === undefined || focused.value === null) return;

    const original = focused.value as { id: number; frame: Record<string, number> };

    try {
      const applied = await runTool('hs_window_layout', {
        preset: 'left-half',
        windowId: original.id,
      });
      expect(applied.isError).not.toBe(true);

      const text =
        (applied as unknown as { content?: { text?: string }[] }).content?.[0]?.text ?? '{}';
      const payload = JSON.parse(text) as {
        screenFrame: { x: number; y: number; w: number; h: number };
        frame: { x: number; y: number; w: number; h: number };
      };

      const predicted = applyFraction(LAYOUT_PRESETS['left-half'], payload.screenFrame);
      // A window manager rounds to whole pixels and some apps refuse sizes
      // below their minimum, so compare within a pixel rather than exactly.
      expect(payload.frame.x).toBeCloseTo(predicted.x, 0);
      expect(payload.frame.y).toBeCloseTo(predicted.y, 0);
      expect(payload.frame.w).toBeCloseTo(predicted.w, 0);
    } finally {
      await bridge.run(
        lua`
local w = hs.window.get(ARGS.id)
if w then w:setFrame({ x = ARGS.frame.x, y = ARGS.frame.y, w = ARGS.frame.w, h = ARGS.frame.h }) end
return true
`,
        original
      );
    }
  });

  it('hs_eval compiles supplied code with load instead of splicing it', async () => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === 'hs_eval');
    expect(tool?.tier).toBe('unsafe');

    const result = await runTool('hs_eval', { code: 'return 6 * 7', timeoutMs: 5000 });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('42');
  });
});
