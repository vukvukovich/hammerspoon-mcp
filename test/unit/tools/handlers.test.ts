/**
 * Exercises every tool handler against a fake bridge.
 *
 * This is where the Lua constants and argument plumbing get checked without a
 * real Hammerspoon: the fake records what the tool asked for, so a test can
 * assert that the right program ran with the right arguments.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HammerspoonBridge } from '../../../src/bridge/bridge.js';
import type { BridgeResult } from '../../../src/bridge/errors.js';
import { DocsIndex } from '../../../src/docs/docs-index.js';
import { ALL_TOOLS } from '../../../src/tools/index.js';

import { fakeBridge, handlerFor, payloadOf, stubDocs } from './tool-harness.js';

const SUCCESS: BridgeResult<unknown> = { ok: true, value: { fine: true } };

/** The zod schema a tool advertises, captured off a stub registration. */
function inputSchemaFor(name: string): { safeParse: (value: unknown) => { success: boolean } } {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);

  let schema: unknown;
  const server = {
    registerTool: (_name: string, config: Record<string, unknown>) => {
      schema = config['inputSchema'];
    },
  };
  tool.register(server as never, { bridge: fakeBridge(SUCCESS).bridge, docs: stubDocs });
  // Boundary cast: the registered schema is a Zod object by construction.
  return schema as { safeParse: (value: unknown) => { success: boolean } };
}

/**
 * hs_api_search reads the bundled documentation from disk instead of talking
 * to Hammerspoon, so the bridge-shaped assertions below do not apply to it. It
 * is named here rather than filtered silently, so adding another bridge-free
 * tool is a deliberate act.
 */
const BRIDGE_FREE_TOOLS = new Set(['hs_api_search']);

/**
 * Tools allowed more than one bridge call per invocation, with the exact
 * count they make against the SUCCESS fake below. Adding a tool here is a
 * deliberate act; the default expectation is one call (#25).
 *
 * hs_move_window: move, then frame read-back. hs_music_control: act, then one
 * status read (the fake's generic value parses loosely, ending the poll).
 * hs_goto_space makes only its first call here because the fake's value fails
 * its result parse and the handler returns early.
 */
const EXPECTED_CALL_COUNTS = new Map<string, number>([
  ['hs_move_window', 2],
  ['hs_music_control', 2],
]);
const BRIDGE_TOOLS = ALL_TOOLS.filter((tool) => !BRIDGE_FREE_TOOLS.has(tool.name)).map(
  (tool) => tool.name
);

describe('every tool', () => {
  it('accounts for every registered tool', () => {
    expect(BRIDGE_TOOLS.length + BRIDGE_FREE_TOOLS.size).toBe(ALL_TOOLS.length);
  });

  it.each(BRIDGE_TOOLS)('%s runs a static Lua program', async (name) => {
    const { bridge, calls } = fakeBridge(SUCCESS);
    const handler = handlerFor(name, { bridge, docs: stubDocs });

    // Arguments that satisfy every schema in the set. handlerFor bypasses
    // schema validation, so nothing here is enforced - but the bag stays
    // schema-valid (expectRole satisfies hs_ui_press's require-one-of
    // refine, #36) so these tests keep passing if validation ever moves
    // into the captured handler.
    await handler(
      {
        id: 1,
        text: 'hi',
        name: 'Safari',
        code: 'return 1',
        lines: 5,
        timeoutMs: 1000,
        expectRole: 'AXButton',
      },
      {}
    );

    // Exactly the declared number of bridge calls, so a tool that regresses
    // into issuing extra side-effecting programs per invocation fails here.
    // Read-back tools (act, then observe) declare their higher counts in
    // EXPECTED_CALL_COUNTS; everything else must make exactly one call. The
    // counts describe behaviour against THIS fake (whose generic response
    // fails some read-back parses and ends those handlers early), so a
    // changed handler flow shows up as a changed number.
    expect(calls.length).toBe(EXPECTED_CALL_COUNTS.get(name) ?? 1);
    for (const call of calls) {
      const lua = call.lua;
      expect(lua.length).toBeGreaterThan(0);
      // Every program must be a fixed constant, so no argument value may
      // appear in any of them.
      expect(lua).not.toContain('Safari');
      expect(lua).not.toContain('return 1\n');
    }
  });

  it.each(BRIDGE_TOOLS)(
    '%s surfaces a bridge failure as an error result with a hint',
    async (name) => {
      const failure: BridgeResult<unknown> = {
        ok: false,
        error: {
          kind: 'HsNotRunning',
          message: 'Hammerspoon is not running.',
          hint: 'Open Hammerspoon and load hs.ipc.',
        },
      };
      const { bridge } = fakeBridge(failure);
      const result = await handlerFor(name, { bridge, docs: stubDocs })(
        {
          id: 1,
          text: 'hi',
          name: 'Safari',
          code: 'return 1',
          lines: 5,
          timeoutMs: 1000,
          expectRole: 'AXButton',
        },
        {}
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('HsNotRunning');
      expect(result.content[0]?.text).toContain('Open Hammerspoon');
    }
  );
});

describe('hs_ui_press expectation guard (#36)', () => {
  it('rejects a press carrying neither expectLabel nor expectRole at the schema', () => {
    // The refine fails validation before the handler runs, so an unchecked
    // press never reaches the machine. The Lua program repeats the check for
    // callers that bypass the schema; the integration suite exercises that
    // arm, since a fake bridge cannot run Lua.
    const schema = inputSchemaFor('hs_ui_press');
    expect(schema.safeParse({ path: '/1/2', app: 'Calculator' }).success).toBe(false);
    expect(schema.safeParse({ path: '/1/2', expectLabel: '7' }).success).toBe(true);
    expect(schema.safeParse({ path: '/1/2', expectRole: 'AXButton' }).success).toBe(true);
  });

  it('bridges a press that carries an expectation', async () => {
    const { bridge, calls } = fakeBridge(SUCCESS);
    const result = await handlerFor('hs_ui_press', { bridge, docs: stubDocs })(
      { path: '/1/2', expectLabel: '7' },
      {}
    );
    expect(result.isError).not.toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.args).toMatchObject({ path: '/1/2', expectLabel: '7' });
  });
});

describe('argument routing', () => {
  it('hs_list_windows forwards its filter to the Lua side', async () => {
    const { bridge, calls } = fakeBridge(SUCCESS);
    await handlerFor('hs_list_windows', { bridge, docs: stubDocs })({ app: 'Ghostty' }, {});
    expect(calls[0]?.args).toMatchObject({ app: 'Ghostty' });
  });

  it('hs_move_window forwards only the coordinates it was given', async () => {
    const { bridge, calls } = fakeBridge(SUCCESS);
    await handlerFor('hs_move_window', { bridge, docs: stubDocs })(
      { id: 7, x: 100, width: 640 },
      {}
    );
    expect(calls[0]?.args).toMatchObject({ id: 7, x: 100, width: 640 });
  });

  it('hs_eval sends only the code, and applies the caller timeout', async () => {
    const { bridge, calls } = fakeBridge(SUCCESS);
    await handlerFor('hs_eval', { bridge, docs: stubDocs })(
      { code: 'return 42', timeoutMs: 2500 },
      {}
    );

    // The timeout is transport configuration, not something Lua should see.
    expect(calls[0]?.args).toEqual({ code: 'return 42' });
    expect(calls[0]?.options).toMatchObject({ timeoutMs: 2500 });
    // The code must travel as an argument, never inside the program text.
    expect(calls[0]?.lua).not.toContain('return 42');
    expect(calls[0]?.lua).toContain('load(ARGS.code');
  });

  it('hs_health annotates the result with the resolved binary path', async () => {
    const { bridge } = fakeBridge({ ok: true, value: { hammerspoonVersion: '1.0.0' } });
    const result = await handlerFor('hs_health', { bridge, docs: stubDocs })({}, {});
    expect(result.content[0]?.text).toContain('/fake/hs');
    expect(result.content[0]?.text).toContain('1.0.0');
  });

  it('hs_reload_config explains the consequences instead of echoing raw output', async () => {
    const { bridge } = fakeBridge({ ok: true, value: { scheduled: true } });
    const result = await handlerFor('hs_reload_config', { bridge, docs: stubDocs })({}, {});
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('hs.ipc');
  });
});

describe('read-back after acting (#17)', () => {
  it('hs_move_window returns the observed frame and flags an adjustment', async () => {
    // The frame read repeats: a diverging frame is re-polled until the settle
    // budget runs out, so the read result is the terminal mock value.
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { id: 7 } })
      .mockResolvedValue({
        ok: true,
        value: { id: 7, frame: { x: -960, y: 33, w: 1000, h: 600 } },
      });
    // Boundary cast: the fake implements the one method the handler uses.
    const bridge = { hsPath: '/fake/hs', run } as unknown as HammerspoonBridge;

    const result = await handlerFor('hs_move_window', { bridge, docs: stubDocs })(
      { id: 7, x: -5000, y: -5000 },
      {}
    );

    const payload = payloadOf<{
      frame: Record<string, number>;
      adjusted: boolean;
      requested: Record<string, number>;
    }>(result);
    expect(payload.frame).toEqual({ x: -960, y: 33, w: 1000, h: 600 });
    expect(payload.adjusted).toBe(true);
    expect(payload.requested).toEqual({ x: -5000, y: -5000 });
  });

  it('hs_move_window reports adjusted=false when the frame landed as asked', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { id: 7 } })
      .mockResolvedValue({
        ok: true,
        value: { id: 7, frame: { x: 100, y: 100, w: 800, h: 600 } },
      });
    const bridge = { hsPath: '/fake/hs', run } as unknown as HammerspoonBridge;

    const result = await handlerFor('hs_move_window', { bridge, docs: stubDocs })(
      { id: 7, x: 100, y: 100, width: 800, height: 600 },
      {}
    );

    const payload = payloadOf<{
      adjusted: boolean;
      requested?: unknown;
    }>(result);
    expect(payload.adjusted).toBe(false);
    expect(payload.requested).toBeUndefined();
  });

  it('hs_goto_space verifies where the switch landed', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { id: 4, position: 2, method: 'keystroke' } })
      .mockResolvedValue({ ok: true, value: { focused: 4 } });
    const bridge = { hsPath: '/fake/hs', run } as unknown as HammerspoonBridge;

    const result = await handlerFor('hs_goto_space', { bridge, docs: stubDocs })(
      { position: 2 },
      {}
    );

    const payload = payloadOf<{
      arrived: boolean;
      id: number;
    }>(result);
    expect(payload.arrived).toBe(true);
    expect(payload.id).toBe(4);
  });

  // Auto-rearranged Spaces can change which id sits at a position between the
  // first attempt and the retry; the verdict must track the retry's fresh
  // resolution (#21). The first resolution answers id 4 but the system sits
  // on 9; the rerun resolves the same position to id 7 and arrives there.
  it('hs_goto_space judges arrival by the rerun target after a rearrange', async () => {
    let gotoCalls = 0;
    const run = vi.fn((luaSource: string) => {
      if (luaSource.includes('allSpaces')) {
        gotoCalls += 1;
        return Promise.resolve({
          ok: true,
          value: { id: gotoCalls === 1 ? 4 : 7, position: 2, method: 'keystroke' },
        });
      }
      return Promise.resolve({ ok: true, value: { focused: gotoCalls >= 2 ? 7 : 9 } });
    });
    const bridge = { hsPath: '/fake/hs', run } as unknown as HammerspoonBridge;

    const result = await handlerFor('hs_goto_space', { bridge, docs: stubDocs })(
      { position: 2 },
      {}
    );

    const payload = payloadOf<{
      arrived: boolean;
      id: number;
    }>(result);
    expect(payload.arrived).toBe(true);
    expect(payload.id).toBe(7);
  }, 10_000);

  // A slow track transition keeps reporting the pre-skip song; next/previous
  // must poll past it rather than trust one settled read (#24).
  it('hs_music_control next polls until the reported track moves', async () => {
    let statusReads = 0;
    const run = vi.fn((luaSource: string) => {
      if (luaSource.includes('unknown action')) {
        return Promise.resolve({
          ok: true,
          value: { player: 'spotify', action: 'next', before: 'Old Song' },
        });
      }
      statusReads += 1;
      return Promise.resolve({
        ok: true,
        value: {
          state: 'playing',
          isPlaying: true,
          track: statusReads === 1 ? 'Old Song' : 'New Song',
        },
      });
    });
    const bridge = { hsPath: '/fake/hs', run } as unknown as HammerspoonBridge;

    const result = await handlerFor('hs_music_control', { bridge, docs: stubDocs })(
      { player: 'spotify', action: 'next' },
      {}
    );

    const payload = payloadOf<{ track: string }>(result);
    expect(payload.track).toBe('New Song');
    expect(statusReads).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('hs_goto_space does not verify when it was already there', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { id: 4, position: 2, alreadyThere: true } });
    const bridge = { hsPath: '/fake/hs', run } as unknown as HammerspoonBridge;

    const result = await handlerFor('hs_goto_space', { bridge, docs: stubDocs })({ id: 4 }, {});

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain('alreadyThere');
  });
});

describe('unencodable results (#29)', () => {
  it('labels a value Lua could not encode instead of passing off its pointer', async () => {
    const { bridge } = fakeBridge({
      ok: true,
      value: 'table: 0x600002a1c000',
      unencodable: true,
    });
    const result = await handlerFor('hs_eval', { bridge, docs: stubDocs })(
      { code: 'local t = {} t.self = t return t', timeoutMs: 1000 },
      {}
    );

    const payload = payloadOf<{
      value: string;
      encodable: boolean;
      hint: string;
    }>(result);
    expect(payload.encodable).toBe(false);
    expect(payload.value).toBe('table: 0x600002a1c000');
    expect(payload.hint).toContain('Return specific fields');
  });

  it('leaves a genuine string that merely looks like a pointer alone', async () => {
    const { bridge } = fakeBridge({ ok: true, value: 'table: 0x600002a1c000' });
    const result = await handlerFor('hs_eval', { bridge, docs: stubDocs })(
      { code: 'return "table: 0x600002a1c000"', timeoutMs: 1000 },
      {}
    );
    expect(JSON.parse(result.content[0]?.text ?? '""')).toBe('table: 0x600002a1c000');
  });
});

describe('hs_open_url schema', () => {
  it('rejects a URL without a scheme before any Lua runs', () => {
    const schema = inputSchemaFor('hs_open_url');
    expect(schema.safeParse({ url: 'not a url at all' }).success).toBe(false);
    expect(schema.safeParse({ url: 'example.com' }).success).toBe(false);
  });

  it('accepts a normal scheme://host URL', () => {
    const schema = inputSchemaFor('hs_open_url');
    expect(schema.safeParse({ url: 'https://example.com' }).success).toBe(true);
  });
});

describe('hs_api_search', () => {
  const realDocs = new DocsIndex(new URL('../../fixtures/docs.json', import.meta.url).pathname);

  const search = async (args: Record<string, unknown>) => {
    const { bridge, calls } = fakeBridge(SUCCESS);
    const result = await handlerFor('hs_api_search', { bridge, docs: realDocs })(args, {});
    return { result, calls };
  };

  it('answers without touching Hammerspoon, so it works while it is closed', async () => {
    const { result, calls } = await search({ query: 'setFrame', limit: 10 });
    expect(calls).toHaveLength(0);
    expect(result.isError).not.toBe(true);
  });

  it('returns the qualified name and exact signature', async () => {
    const { result } = await search({ query: 'setFrame', limit: 10 });
    const payload = payloadOf<{
      results: { qualifiedName: string; signature: string; kind: string }[];
    }>(result);
    expect(payload.results[0]).toMatchObject({
      qualifiedName: 'hs.window.setFrame',
      kind: 'Method',
    });
    expect(payload.results[0]?.signature).toContain('setFrame(rect');
  });

  it('reports the total separately from the page it returned', async () => {
    const { result } = await search({ query: 'hs', limit: 2 });
    const payload = payloadOf<{
      totalMatches: number;
      showing: number;
    }>(result);
    expect(payload.showing).toBe(2);
    expect(payload.totalMatches).toBeGreaterThan(2);
  });

  it('honours the module filter', async () => {
    const { result } = await search({ query: 'show', module: 'alert', limit: 10 });
    const payload = payloadOf<{
      results: { module: string }[];
    }>(result);
    expect(payload.results.every((hit) => hit.module === 'hs.alert')).toBe(true);
  });

  it('suggests how to widen the search when nothing matches', async () => {
    const { result } = await search({ query: 'nonexistentapithing', limit: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No documentation matched');
  });

  it('surfaces a missing documentation file with the override hint', async () => {
    const { bridge } = fakeBridge(SUCCESS);
    const result = await handlerFor('hs_api_search', { bridge, docs: stubDocs })(
      { query: 'anything', limit: 10 },
      {}
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HS_MCP_DOCS_PATH');
  });
});
