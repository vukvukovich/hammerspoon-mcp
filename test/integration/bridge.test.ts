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
import { handlerFor, payloadOf, type ToolResult } from '../unit/tools/tool-harness.js';

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
  // The capture harness and payload extractor are the unit suite's, imported
  // rather than re-implemented, so this file cannot drift from them (#33).
  const runTool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    handlerFor(name, { bridge, docs: new DocsIndex() })(args, {});

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
    const result = await runTool(name, args);
    // The failure text rides along so a red run says what went wrong instead
    // of only "expected true not to be true".
    expect(result.isError, result.content?.[0]?.text ?? '').not.toBe(true);
  });

  // Targets Hammerspoon explicitly rather than the frontmost app. Whatever
  // happens to be focused when the suite runs is ambient state, and a window
  // without an accessibility tree (or one that vanished) made this fail only
  // inside the suite and never standalone.
  it('hs_ui_inspect reads a named application', async () => {
    const result = await runTool('hs_ui_inspect', {
      app: 'Hammerspoon',
      depth: 2,
      limit: 40,
    });

    expect(result.isError).not.toBe(true);
    const payload = payloadOf<{
      app: string;
      tree?: { role?: string };
    }>(result);
    expect(payload.app).toBe('Hammerspoon');
    expect(payload.tree?.role).toBe('AXApplication');
    // Structure only: text field contents must never be reported.
    expect(result.content[0]?.text).not.toContain('"value"');
  });

  // Read-modify-restore, so the suite leaves the machine as it found it.
  it('hs_audio_volume round-trips a change', async () => {
    const read = async (): Promise<{ volume: number }> =>
      payloadOf<{ volume: number }>(await runTool('hs_audio_volume', {}));

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
      (await runTool('hs_settings', { action: 'get', key: 'integration-probe' })).content[0]
        ?.text ?? '';

    try {
      await runTool('hs_settings', { action: 'set', key: 'integration-probe', value: 'v1' });
      expect(await read()).toContain('v1');
    } finally {
      await runTool('hs_settings', { action: 'delete', key: 'integration-probe' });
    }
    expect(await read()).not.toContain('v1');

    // The listing must never surface a key this tool did not write.
    const parsed = payloadOf<{ settings: { key: string }[] }>(
      await runTool('hs_settings', { action: 'list' })
    );
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

    const listed = await runTool('hs_list_shortcuts', {});
    const parsed = payloadOf<{
      shortcuts?: { name: string }[];
    }>(listed);
    const names = (parsed.shortcuts ?? []).map((entry) => entry.name);
    if (!names.includes(safeName)) ctx.skip();

    try {
      const result = await runTool('hs_run_shortcut', { name: safeName });
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
    const result = await runTool('hs_run_shortcut', {
      name: 'no-such-shortcut-xyz',
    });
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
      const result = await runTool('hs_move_window', {
        id: original.id,
        x: -5000,
        y: -5000,
      });
      expect(result.isError).not.toBe(true);

      const payload = payloadOf<{
        frame: { x: number; y: number };
        adjusted: boolean;
      }>(result);

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
    const result = await runTool('hs_open_url', {
      url: 'nosuchscheme00://probe',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('nothing on this Mac handles');
  });

  it('hs_speak rejects a nonexistent voice instead of speaking with another', async () => {
    const result = await runTool('hs_speak', {
      text: 'this must never be spoken',
      voice: 'DefinitelyNotAVoice',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no voice named');
  });

  it('hs_speak reports the full identifier of the voice in use', async () => {
    const result = await runTool('hs_speak', {
      text: 'test',
      voice: 'Daniel',
      rate: 400,
    });
    expect(result.isError).not.toBe(true);
    const payload = payloadOf<{ voice: string }>(result);
    expect(payload.voice.toLowerCase()).toContain('daniel');
    // The identifier, not the short name: constructing with a short name is
    // the silent default-voice fallback (#22).
    expect(payload.voice).toMatch(/^com\.apple\./);
  });

  it('hs_speak refuses a name shared by many voices and lists the candidates', async (ctx) => {
    const result = await runTool('hs_speak', {
      text: 'this must never be spoken',
      voice: 'Eddy',
    });
    // Machines without the Eloquence voice pack have no duplicate Eddys.
    if (result.isError !== true) ctx.skip();
    expect(result.content[0]?.text).toContain('com.apple.eloquence');
  });

  it('hs_notification is honest about unverifiable delivery', async () => {
    const result = await runTool('hs_notification', {
      title: 'hammerspoon-mcp integration test',
      withdrawAfter: 5,
    });
    expect(result.isError).not.toBe(true);
    const payload = payloadOf<{
      posted: boolean;
      deliveryVerified: boolean;
      sent?: boolean;
    }>(result);
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
    const listed = await runTool('hs_list_spaces', {});
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
      const result = await runTool('hs_goto_space', { id: other.id });
      expect(result.isError).not.toBe(true);
      const payload = payloadOf<{ arrived: boolean }>(result);
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
    const listed = await runTool('hs_list_spaces', {});
    const spaces = JSON.parse(listed.content[0]?.text ?? '[]') as {
      id: number;
      isCurrent: boolean;
    }[];
    const current = spaces.find((space) => space.isCurrent);
    expect(current).toBeDefined();
    if (!current) return;

    const result = await runTool('hs_goto_space', {
      id: current.id,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('alreadyThere');
  });

  it('hs_list_voices distinguishes same-named voices by language and id (#18)', async () => {
    const result = await runTool('hs_list_voices', {});
    const payload = payloadOf<{
      voices: { name: string; id: string; language?: string }[];
    }>(result);
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
    const result = await runTool('hs_wifi', {});
    const payload = payloadOf<{
      radio: string;
      scanned: boolean;
      connected: boolean;
      available: string[];
    }>(result);
    expect(['on', 'off']).toContain(payload.radio);
    expect(typeof payload.connected).toBe('boolean');
    if (payload.radio === 'off') {
      expect(payload.scanned).toBe(false);
      expect(payload.available).toEqual([]);
    }
  });

  it('hs_list_apps marks exactly one application frontmost (#18)', async () => {
    const result = await runTool('hs_list_apps', {});
    const apps = JSON.parse(result.content[0]?.text ?? '[]') as { isFrontmost: boolean }[];
    expect(apps.filter((app) => app.isFrontmost)).toHaveLength(1);
  });

  // Chrome specifically, because Chrome keeps control names in AXDescription
  // behind an empty AXTitle, which is the case the label fallback missed.
  it('hs_ui_inspect labels Chrome controls (#18)', async (ctx) => {
    const apps = await runTool('hs_list_apps', { query: 'chrome' });
    const found = JSON.parse(apps.content[0]?.text ?? '[]') as { name: string }[];
    if (!found.some((app) => app.name === 'Google Chrome')) ctx.skip();

    const result = await runTool('hs_ui_inspect', {
      app: 'Google Chrome',
      role: 'button',
      depth: 8,
      limit: 300,
    });
    expect(result.isError).not.toBe(true);

    const text = result.content[0]?.text ?? '{}';
    const labelled = text.match(/"label": "[^"]+"/g) ?? [];
    expect(labelled.length).toBeGreaterThan(0);
  });

  it('hs_settings says whether a key existed (#18)', async () => {
    const missing = await runTool('hs_settings', {
      action: 'get',
      key: 'never-written-probe',
    });
    const payload = payloadOf<{ found: boolean }>(missing);
    expect(payload.found).toBe(false);
  });

  it('hs_music_status reports readable playback states (#18)', async () => {
    const result = await runTool('hs_music_status', {});
    const payload = payloadOf<Record<string, { running: boolean; state?: string }>>(result);
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

      const payload = payloadOf<{
        screenFrame: { x: number; y: number; w: number; h: number };
        frame: { x: number; y: number; w: number; h: number };
      }>(applied);

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

  /**
   * The Lua-side guards, pinned against Hammerspoon itself so their coverage
   * never depends on Calculator being closed (#36). runTool bypasses the
   * schema refine exactly like a direct bridge caller, so the refusals below
   * are the Lua program's own. Both are refusals: nothing gets pressed.
   */
  it('hs_ui_press Lua guards refuse without an expectation and on a dead path (#36)', async () => {
    const unchecked = await runTool('hs_ui_press', { path: '/1', app: 'Hammerspoon' });
    expect(unchecked.isError).toBe(true);
    expect(unchecked.content[0]?.text).toContain('expectLabel');

    const stale = await runTool('hs_ui_press', {
      path: '/999/999',
      app: 'Hammerspoon',
      expectLabel: 'anything',
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toContain('re-run hs_ui_inspect');
  });

  /**
   * Regression test for #27, the wrong-element press.
   *
   * Calculator is the target because every button is consequence-free, and
   * because it reproduces the failure exactly: it inserts a Delete button
   * into its keypad row as soon as the display has input, shifting every
   * later sibling index by one. So a path captured before a press points at
   * a different button after it, which is precisely the situation
   * expectLabel exists to catch.
   *
   * Hygiene (#33): a Calculator the user already has open is their session,
   * not a fixture. The test skips rather than typing into it, and kills only
   * the instance it launched itself. Labels and paths come from
   * hs_ui_inspect through the real tool surface, so this exercises the exact
   * inspect-to-press contract, re-inspecting after the press that reshapes
   * the tree instead of trusting pre-press indexes.
   */
  it('hs_ui_press refuses a path whose element changed under it (#27)', async (ctx) => {
    const wasRunning = await bridge.run(
      lua`return { running = hs.application.get("Calculator") ~= nil }`
    );
    expect(wasRunning.ok).toBe(true);
    if (!wasRunning.ok) return;
    if ((wasRunning.value as { running: boolean }).running) {
      ctx.skip(); // the user's live Calculator is not a test fixture
    }

    type InspectNode = { path?: string; role?: string; label?: string; children?: InspectNode[] };
    const buttonsByLabel = async (): Promise<Map<string, InspectNode>> => {
      const inspected = await runTool('hs_ui_inspect', {
        app: 'Calculator',
        role: 'AXButton',
        depth: 8,
        limit: 500,
      });
      const found = new Map<string, InspectNode>();
      if (inspected.isError === true) return found;
      const walk = (node: InspectNode | undefined): void => {
        if (!node) return;
        if (node.role === 'AXButton' && node.label && node.path) found.set(node.label, node);
        for (const child of node.children ?? []) walk(child);
      };
      walk(payloadOf<{ tree?: InspectNode }>(inspected).tree);
      return found;
    };

    try {
      await bridge.run(lua`hs.application.launchOrFocus("Calculator") return true`);
      // Poll for readiness instead of a fixed sleep: a warm launch is ready
      // well under a second, and no fixed number is long enough for a loaded
      // cold start (#33). The poll itself is a one-line probe - a full
      // depth-8 inspect per 200ms tick would be dozens of tree dumps just to
      // ask "is the keypad up yet".
      const READY_LUA = lua`
local app = hs.application.get("Calculator")
if not app then return false end
local el = hs.axuielement.applicationElement(app)
if not el then return false end
local ok, kids = pcall(function() return el:attributeValue("AXChildren") end)
return ok and type(kids) == "table" and #kids > 0
`;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const ready = await bridge.run(READY_LUA);
        if (ready.ok && ready.value === true) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // The tree can answer before the keypad populates, so the full inspect
      // still retries a few times - just not as the readiness poll.
      let buttons = new Map<string, InspectNode>();
      for (let attempt = 0; attempt < 5 && !buttons.has('7'); attempt += 1) {
        buttons = await buttonsByLabel();
        if (!buttons.has('7')) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // Some Calculator versions label their keys differently; a skip shows
      // in the report, where a silent early return would count as a pass and
      // pin nothing (#33).
      if (!buttons.has('7') || !buttons.has('5')) ctx.skip();

      // A matching expectation acts normally, and says which check ran.
      const pressed = await runTool('hs_ui_press', {
        path: buttons.get('7')?.path ?? '',
        app: 'Calculator',
        expectLabel: '7',
      });
      expect(pressed.isError, pressed.content[0]?.text ?? '').not.toBe(true);
      expect(payloadOf(pressed)).toMatchObject({ label: '7', verified: 'label' });

      // The press put input into the display, which is exactly the state
      // that reshapes the keypad. Fresh paths from a fresh inspection; the
      // refusals below press nothing, so no further reshape happens.
      buttons = await buttonsByLabel();
      const seven = buttons.get('7');
      const five = buttons.get('5');
      if (!seven || !five) ctx.skip();
      if (!seven || !five) return;

      // The guard itself, asserted deterministically: aiming 5's expectation
      // at 7's path is exactly the state a stale path produces.
      const mismatched = await runTool('hs_ui_press', {
        path: seven.path ?? '',
        app: 'Calculator',
        expectLabel: '5',
      });
      expect(mismatched.isError).toBe(true);
      expect(mismatched.content[0]?.text).toContain('refusing to act');
      expect(mismatched.content[0]?.text).toContain("found '7'");

      // Role mismatches are refused the same way, for unlabelled elements.
      const wrongRole = await runTool('hs_ui_press', {
        path: five.path ?? '',
        app: 'Calculator',
        expectRole: 'AXTextField',
      });
      expect(wrongRole.isError).toBe(true);
      expect(wrongRole.content[0]?.text).toContain('refusing to act');

      // A press carrying no expectation at all is refused. runTool bypasses
      // the schema refine exactly like a direct bridge caller would, so the
      // refusal asserted here is the Lua program's own guard (#36). Ordered
      // before the acting press below so the path is known-fresh.
      const unchecked = await runTool('hs_ui_press', {
        path: five.path ?? '',
        app: 'Calculator',
      });
      expect(unchecked.isError).toBe(true);
      expect(unchecked.content[0]?.text).toContain('expectLabel');

      // A matching role acts, and reports the weaker verification level -
      // the "role" arm must be pinned as its own value, not inferred from
      // the absence of a label (#36). Last, because it presses.
      const rolePressed = await runTool('hs_ui_press', {
        path: five.path ?? '',
        app: 'Calculator',
        expectRole: 'AXButton',
      });
      expect(rolePressed.isError, rolePressed.content[0]?.text ?? '').not.toBe(true);
      expect(payloadOf(rolePressed)).toMatchObject({ label: '5', verified: 'role' });
    } finally {
      // Kill only what this test launched: the wasRunning skip above means
      // reaching here implies the instance is ours.
      await bridge.run(lua`
local app = hs.application.get("Calculator")
if app then app:kill() end
return true
`);
    }
  }, 30_000);

  // #30: pins the documented truncation, so a future change to the codec's
  // wrapper that silently altered it would fail here rather than in the wild.
  it('hs_eval returns only the first value, as documented (#30)', async () => {
    const several = await runTool('hs_eval', {
      code: 'return 1, 2, 3',
      timeoutMs: 5000,
    });
    expect(several.isError).not.toBe(true);
    expect(JSON.parse(several.content[0]?.text ?? 'null')).toBe(1);

    // And the workaround the description prescribes returns everything.
    const wrapped = await runTool('hs_eval', {
      code: 'return { first = 1, second = 2, third = 3 }',
      timeoutMs: 5000,
    });
    expect(JSON.parse(wrapped.content[0]?.text ?? '{}')).toEqual({
      first: 1,
      second: 2,
      third: 3,
    });
  });

  // #28: every failure used to be a bare "AppleScript failed", because the
  // error dictionary is the THIRD return value and the code read the second.
  it('hs_applescript reports the real error message and number (#28)', async () => {
    const failure = await runTool('hs_applescript', {
      script: 'return undefinedVariable123',
    });

    expect(failure.isError).toBe(true);
    const text = failure.content[0]?.text ?? '';
    // The variable name and the error number, but not the sentence around
    // them: NSLocalizedDescription is localised, and this must pass on a
    // non-English macOS too (#33).
    expect(text).toContain('undefinedVariable123');
    expect(text).toContain('-2753');
  });

  it('hs_applescript flags a result with no Lua equivalent (#28)', async () => {
    const unrepresentable = await runTool('hs_applescript', {
      script: 'return current date',
    });
    expect(unrepresentable.isError).not.toBe(true);
    const payload = payloadOf<{ encodable: boolean; value?: string; hint?: string }>(
      unrepresentable
    );
    // A date cannot become a Lua value, so it must arrive as its raw form
    // with the shared unrepresentable shape (#35), never as a bare success
    // carrying nothing.
    expect(payload.encodable).toBe(false);
    expect(payload.value).toBeTruthy();
    expect(payload.hint).toContain('Coerce it');

    // And the coercion the hint suggests genuinely works.
    const coerced = await runTool('hs_applescript', {
      script: 'return (current date) as string',
    });
    const coercedPayload = payloadOf<{ result: string }>(coerced);
    expect(typeof coercedPayload.result).toBe('string');
  });

  // #32: null is an answer, not a failure to represent. AppleScript's own
  // null and a script that returns nothing are both plain successes.
  it.each([
    ['missing value', 'return missing value'],
    ['no return value', 'delay 0'],
  ])('hs_applescript reports %s as a plain success (#32)', async (_label, script) => {
    const result = await runTool('hs_applescript', { script });
    expect(result.isError, result.content[0]?.text ?? '').not.toBe(true);
    const payload = payloadOf<Record<string, unknown>>(result);
    expect(payload['ok']).toBe(true);
    expect(payload['encodable']).toBeUndefined();
    expect(payload['result']).toBeUndefined();
  });

  it('hs_applescript decodes non-ASCII in error messages (#32)', async () => {
    const failure = await runTool('hs_applescript', {
      script: 'error "can’t do 😀 that" number -1728',
    });
    expect(failure.isError).toBe(true);
    const text = failure.content[0]?.text ?? '';
    // The smart quote is a BMP escape and the emoji a surrogate pair on the
    // wire; both must arrive as characters, not escapes or mojibake.
    expect(text).toContain('can’t do 😀 that');
    expect(text).toContain('-1728');
  });

  // #34: a throwing __tostring used to escape the codec's fallback pcall,
  // print no marker line, and surface as a baffling ProtocolError.
  it('hs_eval survives a value whose __tostring throws (#34)', async () => {
    const result = await runTool('hs_eval', {
      code: 'return setmetatable({ f = function() end }, { __tostring = function() error("boom") end })',
      timeoutMs: 5000,
    });
    expect(result.isError, result.content[0]?.text ?? '').not.toBe(true);
    const payload = payloadOf<{ encodable?: boolean; value?: string }>(result);
    expect(payload.encodable).toBe(false);
    expect(payload.value).toContain('JSON-safe');
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
