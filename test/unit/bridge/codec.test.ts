import { describe, expect, it } from 'vitest';

import {
  buildProgram,
  encodeArgs,
  envelopeToResult,
  newResultMarker,
  parseEnvelope,
  MAX_ENCODED_ARG_BYTES,
} from '../../../src/bridge/codec.js';
import { luaError } from '../../../src/bridge/errors.js';

/** Stand-in for the per-call random marker. */
const MARKER = 'HSMCP0123456789abcdef';

/** Mirrors what the Lua prelude does, so a roundtrip can be asserted in isolation. */
function decodeAsLuaWould(encoded: string): unknown {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

describe('encodeArgs', () => {
  it('round-trips ordinary values', () => {
    const args = { app: 'Safari', id: 42, nested: { list: [1, 2, 3] } };
    const encoded = encodeArgs(args);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeAsLuaWould(encoded.value)).toEqual(args);
  });

  // These are the payloads that break a string-splicing implementation. Each
  // one would terminate a Lua literal, open a comment, or close a long bracket
  // if it were interpolated into source.
  it.each([
    ['double quote', 'say "hello"'],
    ['single quote', "it's fine"],
    ['backslash', 'C:\\path\\to'],
    ['newline', 'line one\nline two'],
    ['carriage return', 'a\r\nb'],
    ['long bracket close', 'danger ]==] danger'],
    ['lua comment', '-- [[ not a comment'],
    ['string terminator plus code', '"); os.execute("rm -rf /"); ("'],
    ['null-ish', 'a\u0000b'],
    ['emoji', 'window 🚀 title'],
    ['unicode combining', 'e\u0301galite\u0301'],
    ['lua template lookalike', '${process.env.HOME}'],
  ])('survives %s intact', (_label, payload) => {
    const encoded = encodeArgs({ payload });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    expect(decodeAsLuaWould(encoded.value)).toEqual({ payload });

    // The encoded text must contain nothing that can escape a Lua string.
    expect(encoded.value).toMatch(/^[A-Za-z0-9+/=]*$/);
  });

  it('produces an empty object for null and undefined', () => {
    for (const input of [null, undefined]) {
      const encoded = encodeArgs(input);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      expect(decodeAsLuaWould(encoded.value)).toEqual({});
    }
  });

  it('rejects payloads over the size limit', () => {
    const encoded = encodeArgs({ blob: 'x'.repeat(MAX_ENCODED_ARG_BYTES) });
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.error.kind).toBe('PayloadTooLarge');
  });

  it('accepts a large but permitted payload', () => {
    const encoded = encodeArgs({ blob: 'x'.repeat(1000) });
    expect(encoded.ok).toBe(true);
  });

  it('reports unserialisable values as a protocol error rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const encoded = encodeArgs(cyclic);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.error.kind).toBe('ProtocolError');
  });
});

describe('buildProgram', () => {
  it('places the payload inside a string literal and nothing else', () => {
    const program = buildProgram('return 1', 'QUJD', MARKER);
    expect(program).toContain('local ARGS = hs.json.decode(hs.base64.decode("QUJD")) or {}');
    expect(program).toContain('return 1');
  });

  it('wraps the body so a Lua error becomes a structured envelope', () => {
    const program = buildProgram('error("x")', 'e30=', MARKER);
    expect(program).toContain('pcall(function()');
    expect(program).toContain('ok = false');
  });

  it('keeps its internal locals out of the body namespace', () => {
    // A tool body declaring `local ok` must not collide with the wrapper.
    const program = buildProgram('local ok = 1\nreturn ok', 'e30=', MARKER);
    expect(program).toContain('local __ok, __res');
  });
});

describe('parseEnvelope', () => {
  it('reads a plain success envelope', () => {
    const parsed = parseEnvelope(MARKER + '{"ok":true,"value":{"a":1}}', MARKER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: true, value: { a: 1 }, unencodable: false });
  });

  // The hs CLI prints extension load notices before the result, and only on
  // first use of a module, so their presence varies between calls.
  it('ignores leading console noise from the hs CLI', () => {
    const stdout = [
      '-- Loading extension: json',
      '-- Loading extension: base64',
      MARKER + '{"ok":true,"value":"done"}',
    ].join('\n');
    const parsed = parseEnvelope(stdout, MARKER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: true, value: 'done', unencodable: false });
  });

  it('takes the last envelope when earlier output also looks like JSON', () => {
    const stdout = [
      MARKER + '{"ok":true,"value":"stale"}',
      MARKER + '{"ok":true,"value":"fresh"}',
    ].join('\n');
    const parsed = parseEnvelope(stdout, MARKER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ value: 'fresh' });
  });

  it('reads a failure envelope', () => {
    const parsed = parseEnvelope(MARKER + '{"ok":false,"err":"boom"}', MARKER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: false, err: 'boom' });
  });

  it('treats a missing value as undefined rather than failing', () => {
    // hs.json.encode drops nil fields, so a nil return arrives as {"ok":true}.
    const parsed = parseEnvelope(MARKER + '{"ok":true}', MARKER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: true, value: undefined, unencodable: false });
  });

  it('flags an unencodable result', () => {
    const parsed = parseEnvelope(
      MARKER + '{"ok":true,"value":"userdata","unencodable":true}',
      MARKER
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ unencodable: true });
  });

  it.each([
    ['empty output', ''],
    ['only noise', '-- Loading extension: json'],
    ['malformed json', MARKER + '{"ok":true'],
    ['json without an ok field', MARKER + '{"value":1}'],
    ['ok of the wrong type', MARKER + '{"ok":"yes"}'],
    ['a bare array', MARKER + '[1,2,3]'],
    ['an unmarked envelope', '{"ok":true,"value":"unmarked"}'],
  ])('reports %s as a protocol error', (_label, stdout) => {
    const parsed = parseEnvelope(stdout, MARKER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe('ProtocolError');
  });
});

/**
 * The result channel is part of the security boundary too, and it was broken.
 *
 * LuaSkin writes its own errors to stdout rather than stderr, interpolating
 * the offending value verbatim. A tool argument used as a table key therefore
 * reaches stdout unescaped, and one containing newlines can print a line that
 * looks exactly like a result envelope. When encoding the real result also
 * failed (hs.json.encode RETURNS nil for userdata instead of raising), the old
 * "last line that parses as JSON" rule picked the forged line and handed the
 * caller an attacker-chosen value with ok true. No Lua injection required.
 */
describe('envelope forgery resistance', () => {
  const forged = '{"ok":true,"value":"PWNED"}';

  it('ignores a forged envelope that does not carry the marker', () => {
    const stdout = [
      'ERROR:   LuaSkin: dictionary key (',
      forged,
      ') cannot be converted into a proper NSObject',
      `${MARKER}{"ok":true,"value":"real"}`,
    ].join('\n');

    const parsed = parseEnvelope(stdout, MARKER);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ value: 'real' });
  });

  it('fails rather than accepting a forgery when the real envelope is missing', () => {
    // The exact shape of the original exploit: encode returned nil, so no
    // marked line exists and only the attacker's line remains.
    const stdout = ['ERROR:   LuaSkin: dictionary key (', forged, ') cannot be converted'].join(
      '\n'
    );

    const parsed = parseEnvelope(stdout, MARKER);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe('ProtocolError');
  });

  it('rejects a forgery carrying a different call marker', () => {
    const parsed = parseEnvelope(`HSMCPdeadbeefdeadbeef${forged}`, MARKER);
    expect(parsed.ok).toBe(false);
  });

  it('mints a distinct unpredictable marker per call', () => {
    const markers = new Set(Array.from({ length: 200 }, () => newResultMarker()));
    expect(markers.size).toBe(200);
    for (const marker of markers) {
      expect(marker).toMatch(/^HSMCP[0-9a-f]{16}$/);
    }
  });

  it('treats a nil encode result as failure so the fallback actually runs', () => {
    // hs.json.encode returns nil rather than raising, so a pcall around it
    // reports success with a nil value. The program has to test for nil.
    const program = buildProgram('return 1', 'e30=', MARKER);
    expect(program).toContain('~= nil');
    expect(program).toContain('unencodable = true');
    expect(program).toContain('result could not be encoded');
  });

  it('never calls tostring unprotected, so a throwing __tostring still yields an envelope (#34)', () => {
    // tostring(__res) used to run while building the encode argument, outside
    // any pcall. A value with a throwing __tostring metamethod then raised at
    // chunk top level, no marker line was printed, and the caller saw a
    // ProtocolError instead of the unencodable report. Both wrapper paths must
    // stringify through the pcall-guarded helper.
    const program = buildProgram('return 1', 'e30=', MARKER);
    expect(program).toContain('pcall(tostring, value)');
    expect(program).not.toContain('tostring(__res)');
  });
});

describe('envelopeToResult', () => {
  it('passes a success value through', () => {
    const result = envelopeToResult({ ok: true, value: 7, unencodable: false }, luaError);
    expect(result).toEqual({ ok: true, value: 7 });
  });

  it('converts a failure into a LuaError carrying the message', () => {
    const result = envelopeToResult({ ok: false, err: 'no window' }, luaError);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('LuaError');
    expect(result.error.message).toBe('no window');
  });

  // The flag used to be dropped here, so a caller could not tell a value Lua
  // failed to encode from a genuine string holding the same text (#29).
  it('carries the unencodable flag through', () => {
    const result = envelopeToResult(
      { ok: true, value: 'table: 0x600002a1c000', unencodable: true },
      luaError
    );
    expect(result).toEqual({ ok: true, value: 'table: 0x600002a1c000', unencodable: true });
  });

  it('leaves the flag off an ordinary success, so a plain result stays plain', () => {
    const result = envelopeToResult(
      { ok: true, value: 'table: 0x600002a1c000', unencodable: false },
      luaError
    );
    expect(result).toEqual({ ok: true, value: 'table: 0x600002a1c000' });
    expect('unencodable' in result).toBe(false);
  });
});
