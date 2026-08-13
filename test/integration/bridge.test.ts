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

const READ_FRAME_PROBE_LUA = lua`
local w = hs.window.get(ARGS.id)
if not w then error("gone", 0) end
local f = w:frame()
return { frame = { x = f.x, y = f.y, w = f.w, h = f.h } }
`;

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

  // #19's acceptance criterion. Under spawn-per-call this level of
  // concurrency lost most of the calls to CFMessagePort churn (5 of 15
  // succeeded); over the persistent socket all of them must land.
  it('forty simultaneous calls all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => bridge.run(lua`return 7`)));
    expect(results.filter((result) => result.ok)).toHaveLength(40);
  });

  it('the socket lives in a directory only this user can reach', async () => {
    // Force the transport up, then inspect where it lives.
    const probe = await bridge.run(lua`return "up"`);
    expect(probe.ok).toBe(true);

    const { defaultSocketPath } = await import('../../src/bridge/socket-transport.js');
    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    const socketPath = defaultSocketPath();
    const stats = fs.statSync(socketPath, { throwIfNoEntry: false });
    // The bridge may be on the spawn fallback if bootstrap failed; only when
    // the socket exists is there a permission surface to verify.
    if (stats === undefined) return;
    const dirMode = fs.statSync(nodePath.dirname(socketPath)).mode;
    // No group or other bits on the containing directory: $TMPDIR is
    // per-user 0700 on macOS, which is what gates access to the socket.
    expect(dirMode & 0o077).toBe(0);
  });

  it('the spawn transport still round-trips when forced', async () => {
    const spawnBridge = new HammerspoonBridge({ transport: 'spawn' });
    const result = await spawnBridge.run(lua`return "spawned"`);
    expect(result).toEqual({ ok: true, value: 'spawned' });
  });

  // The deliberately-wedging timeout test lives at the END of the tool
  // describe below, not here: killing a client mid-call opens a window of
  // degraded IPC (the hs CLI intermittently dies with
  // NSDestinationInvalidException for the next ~20s), and every test that ran
  // after it in file order was racing that window.
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
    ['hs_music_status', {}],
    ['hs_list_voices', {}],
    ['hs_network', {}],
    ['hs_caps_lock', {}],
    ['hs_default_browser', {}],
    ['hs_settings', { action: 'list' }],
  ])('%s succeeds', async (name, args) => {
    const result = (await runTool(name, args)) as unknown as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    // The failure text rides along so a red run says what went wrong instead
    // of only "expected true not to be true".
    expect(result.isError, result.content?.[0]?.text ?? '').not.toBe(true);
  });

  // Targets Hammerspoon explicitly rather than the frontmost app. Whatever
  // happens to be focused when the suite runs is ambient state, and a window
  // without an accessibility tree (or one that vanished) made this fail only
  // inside the suite and never standalone.
  it('hs_ui_inspect reads a named application', async () => {
    const result = (await runTool('hs_ui_inspect', {
      app: 'Hammerspoon',
      depth: 2,
      limit: 40,
    })) as unknown as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      app: string;
      tree?: { role?: string };
    };
    expect(payload.app).toBe('Hammerspoon');
    expect(payload.tree?.role).toBe('AXApplication');
    // Structure only: text field contents must never be reported.
    expect(result.content[0]?.text).not.toContain('"value"');
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

  // Namespacing is a safety property, not a convenience: an unprefixed key
  // could overwrite something the user's own config depends on.
  it('hs_settings round-trips and stays inside its namespace', async () => {
    const read = async (): Promise<string> =>
      (
        (await runTool('hs_settings', {
          action: 'get',
          key: 'integration-probe',
        })) as unknown as { content: { text: string }[] }
      ).content[0]?.text ?? '';

    try {
      await runTool('hs_settings', { action: 'set', key: 'integration-probe', value: 'v1' });
      expect(await read()).toContain('v1');
    } finally {
      await runTool('hs_settings', { action: 'delete', key: 'integration-probe' });
    }
    expect(await read()).not.toContain('v1');

    // The listing must never surface a key this tool did not write.
    const listed =
      (
        (await runTool('hs_settings', { action: 'list' })) as unknown as {
          content: { text: string }[];
        }
      ).content[0]?.text ?? '{}';
    const parsed = JSON.parse(listed) as { settings: { key: string }[] };
    for (const entry of parsed.settings) {
      expect(entry.key).not.toContain('hsmcp.');
    }
  });

  // Regression test for #15: every call used to fail before reaching the
  // Shortcut at all. Proving the fix needs a real start, but running an
  // arbitrary user shortcut is a side-effect roulette, so this only runs a
  // shortcut named by HS_MCP_TEST_SHORTCUT (or the default below) and skips
  // when the machine has no such shortcut. The spawned CLI is killed
  // afterwards, because an interactive or broken shortcut can wait forever
  // when run non-interactively and a test must not leak processes.
  it('hs_run_shortcut starts a real shortcut without erroring', async (ctx) => {
    const safeName = process.env['HS_MCP_TEST_SHORTCUT'] ?? 'Open Finder file manager';

    const listed = (await runTool('hs_list_shortcuts', {})) as unknown as {
      content: { text: string }[];
    };
    const parsed = JSON.parse(listed.content[0]?.text ?? '{}') as {
      shortcuts?: { name: string }[];
    };
    const names = (parsed.shortcuts ?? []).map((entry) => entry.name);
    if (!names.includes(safeName)) ctx.skip();

    try {
      const result = (await runTool('hs_run_shortcut', { name: safeName })) as unknown as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('started');
    } finally {
      const { execFile } = await import('node:child_process');
      execFile('/usr/bin/pkill', ['-f', `shortcuts run -- ${safeName}`], () => {
        // pkill exits 1 when nothing matched, which is the happy case here.
      });
    }
  });

  it('hs_run_shortcut lists the alternatives when nothing matches', async () => {
    const result = (await runTool('hs_run_shortcut', {
      name: 'no-such-shortcut-xyz',
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Available');
  });

  it('hs_audio_set_device lists the alternatives when nothing matches', async () => {
    const result = await runTool('hs_audio_set_device', { name: 'no-such-device-xyz' });
    expect(result.isError).toBe(true);
  });

  /**
   * The #17 criterion: move a window somewhere impossible and assert the
   * reported frame matches reality, not the request. Whether macOS clamps is
   * app-dependent, so the assertion is reported == independently-observed,
   * with the adjusted flag agreeing.
   */
  it('hs_move_window reports the frame the system actually applied', async () => {
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
      const result = (await runTool('hs_move_window', {
        id: original.id,
        x: -5000,
        y: -5000,
      })) as unknown as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).not.toBe(true);

      const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
        frame: { x: number; y: number };
        adjusted: boolean;
      };

      const observed = await bridge.run(READ_FRAME_PROBE_LUA, { id: original.id });
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      const reality = observed.value as { frame: { x: number; y: number } };

      expect(payload.frame.x).toBeCloseTo(reality.frame.x, 0);
      expect(payload.frame.y).toBeCloseTo(reality.frame.y, 0);

      const differs =
        Math.abs(payload.frame.x - -5000) > 1 || Math.abs(payload.frame.y - -5000) > 1;
      expect(payload.adjusted).toBe(differs);
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

  it('hs_open_url errors for a scheme nothing handles', async () => {
    const result = (await runTool('hs_open_url', {
      url: 'nosuchscheme00://probe',
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('nothing on this Mac handles');
  });

  it('hs_speak rejects a nonexistent voice instead of speaking with another', async () => {
    const result = (await runTool('hs_speak', {
      text: 'this must never be spoken',
      voice: 'DefinitelyNotAVoice',
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no voice named');
  });

  it('hs_speak reports the full identifier of the voice in use', async () => {
    const result = (await runTool('hs_speak', {
      text: 'test',
      voice: 'Daniel',
      rate: 400,
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { voice: string };
    expect(payload.voice.toLowerCase()).toContain('daniel');
    // The identifier, not the short name: constructing with a short name is
    // the silent default-voice fallback (#22).
    expect(payload.voice).toMatch(/^com\.apple\./);
  });

  it('hs_speak refuses a name shared by many voices and lists the candidates', async (ctx) => {
    const result = (await runTool('hs_speak', {
      text: 'this must never be spoken',
      voice: 'Eddy',
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    // Machines without the Eloquence voice pack have no duplicate Eddys.
    if (result.isError !== true) ctx.skip();
    expect(result.content[0]?.text).toContain('com.apple.eloquence');
  });

  it('hs_notification is honest about unverifiable delivery', async () => {
    const result = (await runTool('hs_notification', {
      title: 'hammerspoon-mcp integration test',
      withdrawAfter: 5,
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      posted: boolean;
      deliveryVerified: boolean;
      sent?: boolean;
    };
    expect(payload.posted).toBe(true);
    expect(payload.deliveryVerified).toBe(false);
    expect(payload.sent).toBeUndefined();
  });

  /**
   * A real switch to a different desktop and back, verified against
   * hs.spaces.focusedSpace() independently of what the tool claims. Skips on a
   * machine with a single desktop.
   */
  it('hs_goto_space actually lands on the requested desktop', async (ctx) => {
    const listed = (await runTool('hs_list_spaces', {})) as unknown as {
      content: { text: string }[];
    };
    const spaces = JSON.parse(listed.content[0]?.text ?? '[]') as {
      id: number;
      type: string;
      isCurrent: boolean;
    }[];
    const current = spaces.find((space) => space.isCurrent);
    const other = spaces.find((space) => space.type === 'user' && !space.isCurrent);
    if (!current || !other) ctx.skip();
    if (!current || !other) return;

    try {
      const result = (await runTool('hs_goto_space', { id: other.id })) as unknown as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(result.content[0]?.text ?? '{}') as { arrived: boolean };
      expect(payload.arrived).toBe(true);

      const observed = await bridge.run(lua`return { focused = hs.spaces.focusedSpace() }`);
      expect(observed.ok).toBe(true);
      if (observed.ok) {
        expect((observed.value as { focused: number }).focused).toBe(other.id);
      }
    } finally {
      await runTool('hs_goto_space', { id: current.id });
    }
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

  it('hs_list_voices distinguishes same-named voices by language and id (#18)', async () => {
    const result = (await runTool('hs_list_voices', {})) as unknown as {
      content: { text: string }[];
    };
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      voices: { name: string; id: string; language?: string }[];
    };
    expect(payload.voices.length).toBeGreaterThan(0);

    const ids = new Set(payload.voices.map((voice) => voice.id));
    expect(ids.size).toBe(payload.voices.length);

    // The named duplicates that motivated the fix must be tellable apart.
    const eddys = payload.voices.filter((voice) => voice.name === 'Eddy');
    if (eddys.length > 1) {
      const languages = new Set(eddys.map((voice) => voice.language));
      expect(languages.size).toBe(eddys.length);
    }
  });

  it('hs_wifi never claims a scan the radio could not have run (#18)', async () => {
    const result = (await runTool('hs_wifi', {})) as unknown as {
      content: { text: string }[];
    };
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      radio: string;
      scanned: boolean;
      connected: boolean;
      available: string[];
    };
    expect(['on', 'off']).toContain(payload.radio);
    expect(typeof payload.connected).toBe('boolean');
    if (payload.radio === 'off') {
      expect(payload.scanned).toBe(false);
      expect(payload.available).toEqual([]);
    }
  });

  it('hs_list_apps marks exactly one application frontmost (#18)', async () => {
    const result = (await runTool('hs_list_apps', {})) as unknown as {
      content: { text: string }[];
    };
    const apps = JSON.parse(result.content[0]?.text ?? '[]') as { isFrontmost: boolean }[];
    expect(apps.filter((app) => app.isFrontmost)).toHaveLength(1);
  });

  // Chrome specifically, because Chrome keeps control names in AXDescription
  // behind an empty AXTitle, which is the case the label fallback missed.
  it('hs_ui_inspect labels Chrome controls (#18)', async (ctx) => {
    const apps = (await runTool('hs_list_apps', { query: 'chrome' })) as unknown as {
      content: { text: string }[];
    };
    const found = JSON.parse(apps.content[0]?.text ?? '[]') as { name: string }[];
    if (!found.some((app) => app.name === 'Google Chrome')) ctx.skip();

    const result = (await runTool('hs_ui_inspect', {
      app: 'Google Chrome',
      role: 'button',
      depth: 8,
      limit: 300,
    })) as unknown as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).not.toBe(true);

    const text = result.content[0]?.text ?? '{}';
    const labelled = text.match(/"label": "[^"]+"/g) ?? [];
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('hs_settings says whether a key existed (#18)', async () => {
    const missing = (await runTool('hs_settings', {
      action: 'get',
      key: 'never-written-probe',
    })) as unknown as { content: { text: string }[] };
    const payload = JSON.parse(missing.content[0]?.text ?? '{}') as { found: boolean };
    expect(payload.found).toBe(false);
  });

  it('hs_music_status reports readable playback states (#18)', async () => {
    const result = (await runTool('hs_music_status', {})) as unknown as {
      content: { text: string }[];
    };
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<
      string,
      { running: boolean; state?: string }
    >;
    for (const player of Object.values(payload)) {
      if (player.running && player.state !== undefined) {
        expect(['playing', 'paused', 'stopped', 'unknown']).toContain(player.state);
        expect(player.state).not.toMatch(/^kPS/);
      }
    }
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

  /**
   * Deliberately second-to-last, see the note in the bridge describe: the
   * timeout kill degrades IPC for the tests that follow, so only the reload
   * test (which perturbs everything anyway) comes after it.
   */
  it('honours a short timeout', async () => {
    // usleep blocks Hammerspoon's main thread, and killing our client does not
    // wake it. So keep the sleep barely longer than the timeout: a long one
    // leaves Hammerspoon unresponsive well after this test passes, and every
    // test that follows races it.
    const result = await bridge.run(lua`hs.timer.usleep(700000) return 1`, {}, { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Timeout');

    await waitForResponsive();
  });

  /**
   * Regression test for #16, deliberately last: it reloads the user's real
   * configuration, which resets all in-memory Hammerspoon state and takes a
   * few seconds, so everything after it would race the reload.
   *
   * The killer sequence was hs_speak with the utterance still in flight when
   * hs_reload_config tore the Lua state down: the synthesiser's completion
   * callback then unrefs into the dead state and aborts the entire app. The
   * tool now stops the speaker first. This proves the process survives the
   * exact sequence that used to kill it, and that the bridge answers again.
   */
  it('hs_reload_config survives with speech in flight (#16)', async () => {
    const spoken = await runTool('hs_speak', {
      text: 'integration test: reloading the configuration while this sentence is still being spoken',
    });
    expect(spoken.isError).not.toBe(true);

    const result = await runTool('hs_reload_config', {});
    expect(result.isError).not.toBe(true);

    // Give the scheduled reload time to fire and the config time to load.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await waitForResponsive(30);

    const probe = await bridge.run(lua`return "alive after reload"`);
    expect(probe).toEqual({ ok: true, value: 'alive after reload' });
  }, 30_000);
});
