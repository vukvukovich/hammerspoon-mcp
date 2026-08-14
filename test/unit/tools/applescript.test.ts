/**
 * hs_applescript's TypeScript half: escape decoding and result shaping.
 *
 * The Lua half is deliberately thin (see APPLESCRIPT_LUA) because none of this
 * logic can be unit-tested there. Everything that can go wrong in text
 * handling lives here where it can be pinned.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { BridgeResult } from '../../../src/bridge/errors.js';
import {
  APPLESCRIPT_FAILED_PREFIX,
  decodeNsStringEscapes,
} from '../../../src/tools/unsafe/applescript.js';

import { fakeBridge, handlerFor, payloadOf, stubDocs } from './tool-harness.js';

function appleScriptHandler(result: BridgeResult<unknown>) {
  return handlerFor('hs_applescript', { bridge: fakeBridge(result).bridge, docs: stubDocs });
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

describe('the decode gate prefix', () => {
  it('is the exact text the Lua failure branch builds messages from', async () => {
    // The TS gate dispatches escape decoding on this prefix. It is prose
    // coupling by necessity (the Lua error crosses as a plain string), so
    // this pin makes rewording either side fail a test instead of silently
    // disabling the decode.
    const source = await readFile(
      new URL('../../../src/tools/unsafe/applescript.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain(`local message = "${APPLESCRIPT_FAILED_PREFIX}"`);
  });
});

describe('hs_applescript result shaping', () => {
  it('reports a raw-only result with the shared unrepresentable shape (#35)', async () => {
    const handler = appleScriptHandler({
      ok: true,
      value: { ok: true, raw: 'date "Friday, 14. August 2026"' },
    });
    const result = await handler({ script: 'return current date' }, {});
    expect(result.isError).not.toBe(true);
    const payload = payloadOf<Record<string, unknown>>(result);
    // ok rides along on every success shape this tool emits, so a caller
    // reading payload.ok is never told a successful call was malformed.
    expect(payload['ok']).toBe(true);
    expect(payload['encodable']).toBe(false);
    expect(payload['value']).toBe('date "Friday, 14. August 2026"');
    expect(typeof payload['hint']).toBe('string');
  });

  it('reports a genuine result as-is', async () => {
    const handler = appleScriptHandler({ ok: true, value: { ok: true, result: 42 } });
    const result = await handler({ script: 'return 42' }, {});
    expect(result.isError).not.toBe(true);
    expect(payloadOf(result)).toEqual({ ok: true, result: 42 });
  });

  it('decodes NSString escapes in Lua error messages before they reach the caller', async () => {
    const handler = appleScriptHandler({
      ok: false,
      error: {
        kind: 'LuaError',
        message: 'AppleScript failed: Can\\U2019t do \\Ud83d\\Ude00 that (error -1728)',
        hint: 'irrelevant here',
      },
    });
    const result = await handler({ script: 'error "x"' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Can’t do 😀 that (error -1728)');
  });

  it('leaves non-AppleScript Lua errors undecoded, so their backslashes survive', async () => {
    // Only the AppleScript failure branch's messages went through NSString
    // escaping; a LuaSkin error or the program's own guard text never did,
    // and decoding it would corrupt genuine backslash sequences.
    const handler = appleScriptHandler({
      ok: false,
      error: { kind: 'LuaError', message: 'bad argument: got "\\U0041"', hint: 'irrelevant' },
    });
    const result = await handler({ script: 'x' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('\\U0041');
  });

  it('leaves non-Lua bridge failures alone', async () => {
    const handler = appleScriptHandler({
      ok: false,
      error: { kind: 'Timeout', message: 'Hammerspoon did not respond', hint: 'wait' },
    });
    const result = await handler({ script: 'delay 60' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Timeout');
  });
});
