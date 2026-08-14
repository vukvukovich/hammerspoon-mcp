/**
 * hs_applescript's TypeScript half: escape decoding and result shaping.
 *
 * The Lua half is deliberately thin (see APPLESCRIPT_LUA) because none of this
 * logic can be unit-tested there. Everything that can go wrong in text
 * handling lives here where it can be pinned.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HammerspoonBridge } from '../../../src/bridge/bridge.js';
import type { BridgeResult } from '../../../src/bridge/errors.js';
import { decodeNsStringEscapes } from '../../../src/tools/unsafe/applescript.js';
import { DocsIndex } from '../../../src/docs/docs-index.js';
import { ALL_TOOLS } from '../../../src/tools/index.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

function fakeBridge(result: BridgeResult<unknown>): HammerspoonBridge {
  return {
    hsPath: '/fake/hs',
    run: vi.fn(async () => Promise.resolve(result)),
  } as unknown as HammerspoonBridge;
}

function appleScriptHandler(bridge: HammerspoonBridge) {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === 'hs_applescript');
  if (tool === undefined) throw new Error('hs_applescript not registered');
  let captured: ((args: unknown, ctx: unknown) => Promise<ToolResult>) | undefined;
  const server = {
    registerTool: (
      _name: string,
      _config: unknown,
      handler: (args: unknown, ctx: unknown) => Promise<ToolResult>
    ) => {
      captured = handler;
    },
  };
  tool.register(server as never, { bridge, docs: new DocsIndex('/nonexistent/docs.json') });
  if (captured === undefined) throw new Error('handler not captured');
  return captured;
}

describe('decodeNsStringEscapes', () => {
  it('decodes a BMP escape, the case the function was written for', () => {
    expect(decodeNsStringEscapes('Can\\U2019t divide')).toBe('Can’t divide');
  });

  it('decodes a surrogate pair as one character, not two invalid halves (#32)', () => {
    expect(decodeNsStringEscapes('fail \\Ud83d\\Ude00 here')).toBe('fail 😀 here');
  });

  it('handles lowercase and uppercase hex alike', () => {
    expect(decodeNsStringEscapes('\\UD83D\\UDE00')).toBe('😀');
  });

  it('leaves an unpaired high surrogate as literal text', () => {
    expect(decodeNsStringEscapes('broken \\Ud83d end')).toBe('broken \\Ud83d end');
  });

  it('leaves a stray low surrogate as literal text', () => {
    expect(decodeNsStringEscapes('broken \\Ude00 end')).toBe('broken \\Ude00 end');
  });

  it('decodes consecutive non-surrogate escapes independently', () => {
    expect(decodeNsStringEscapes('\\U0041\\U0042')).toBe('AB');
  });

  it('reads a doubled backslash as one literal backslash, so quoted user data survives (#32)', () => {
    // NSError doubles literal backslashes (verified live), which is what makes
    // "\\U0041" distinguishable from a genuine escape: it arrives as
    // "\\\\U0041" and must decode to the five literal characters \U0041.
    expect(decodeNsStringEscapes('parse "\\\\U0041" failed')).toBe('parse "\\U0041" failed');
  });

  it('passes text without escapes through untouched', () => {
    const plain = 'The variable x is not defined. (error -2753)';
    expect(decodeNsStringEscapes(plain)).toBe(plain);
  });
});

describe('hs_applescript result shaping', () => {
  it('reports a raw-only result with the shared unrepresentable shape (#35)', async () => {
    const handler = appleScriptHandler(
      fakeBridge({ ok: true, value: { ok: true, raw: 'date "Friday, 14. August 2026"' } })
    );
    const result = await handler({ script: 'return current date' }, {});
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload['encodable']).toBe(false);
    expect(payload['value']).toBe('date "Friday, 14. August 2026"');
    expect(typeof payload['hint']).toBe('string');
  });

  it('reports a genuine result as-is', async () => {
    const handler = appleScriptHandler(fakeBridge({ ok: true, value: { ok: true, result: 42 } }));
    const result = await handler({ script: 'return 42' }, {});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({ ok: true, result: 42 });
  });

  it('decodes NSString escapes in Lua error messages before they reach the caller', async () => {
    const handler = appleScriptHandler(
      fakeBridge({
        ok: false,
        error: {
          kind: 'LuaError',
          message: 'AppleScript failed: Can\\U2019t do \\Ud83d\\Ude00 that (error -1728)',
          hint: 'irrelevant here',
        },
      })
    );
    const result = await handler({ script: 'error "x"' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Can’t do 😀 that (error -1728)');
  });

  it('leaves non-Lua bridge failures alone', async () => {
    const handler = appleScriptHandler(
      fakeBridge({
        ok: false,
        error: { kind: 'Timeout', message: 'Hammerspoon did not respond', hint: 'wait' },
      })
    );
    const result = await handler({ script: 'delay 60' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Timeout');
  });
});
