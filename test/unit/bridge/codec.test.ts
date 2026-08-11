import { describe, expect, it } from 'vitest';

import {
  buildProgram,
  encodeArgs,
  envelopeToResult,
  parseEnvelope,
  MAX_ENCODED_ARG_BYTES,
} from '../../../src/bridge/codec.js';
import { luaError } from '../../../src/bridge/errors.js';

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
    const program = buildProgram('return 1', 'QUJD');
    expect(program).toContain('local ARGS = hs.json.decode(hs.base64.decode("QUJD")) or {}');
    expect(program).toContain('return 1');
  });

  it('wraps the body so a Lua error becomes a structured envelope', () => {
    const program = buildProgram('error("x")', 'e30=');
    expect(program).toContain('pcall(function()');
    expect(program).toContain('ok = false');
  });

  it('keeps its internal locals out of the body namespace', () => {
    // A tool body declaring `local ok` must not collide with the wrapper.
    const program = buildProgram('local ok = 1\nreturn ok', 'e30=');
    expect(program).toContain('local __ok, __res');
  });
});

describe('parseEnvelope', () => {
  it('reads a plain success envelope', () => {
    const parsed = parseEnvelope('{"ok":true,"value":{"a":1}}');
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
      '{"ok":true,"value":"done"}',
    ].join('\n');
    const parsed = parseEnvelope(stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: true, value: 'done', unencodable: false });
  });

  it('takes the last envelope when earlier output also looks like JSON', () => {
    const stdout = ['{"ok":true,"value":"stale"}', '{"ok":true,"value":"fresh"}'].join('\n');
    const parsed = parseEnvelope(stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ value: 'fresh' });
  });

  it('reads a failure envelope', () => {
    const parsed = parseEnvelope('{"ok":false,"err":"boom"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: false, err: 'boom' });
  });

  it('treats a missing value as undefined rather than failing', () => {
    // hs.json.encode drops nil fields, so a nil return arrives as {"ok":true}.
    const parsed = parseEnvelope('{"ok":true}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ok: true, value: undefined, unencodable: false });
  });

  it('flags an unencodable result', () => {
    const parsed = parseEnvelope('{"ok":true,"value":"userdata","unencodable":true}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ unencodable: true });
  });

  it.each([
    ['empty output', ''],
    ['only noise', '-- Loading extension: json'],
    ['malformed json', '{"ok":true'],
    ['json without an ok field', '{"value":1}'],
    ['ok of the wrong type', '{"ok":"yes"}'],
    ['a bare array', '[1,2,3]'],
  ])('reports %s as a protocol error', (_label, stdout) => {
    const parsed = parseEnvelope(stdout);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe('ProtocolError');
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
});
