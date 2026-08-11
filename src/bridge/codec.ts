/**
 * The argument codec: the reason this server is safe to point at untrusted input.
 *
 * Tool arguments are never spliced into Lua source. They are JSON-encoded, then
 * base64-encoded, and the base64 text is placed inside a string literal in a
 * fixed prelude:
 *
 *     local ARGS = hs.json.decode(hs.base64.decode("<base64>"))
 *
 * The base64 alphabet is [A-Za-z0-9+/=]. None of those characters can end a Lua
 * string, start an escape sequence, open a comment, or close a long bracket. So
 * argument content cannot break out of the literal no matter what it contains.
 * Safety here is a property of the alphabet, not of escaping discipline, which
 * means it cannot be eroded by a future edit that forgets to escape something.
 *
 * Tool bodies are static constants that read fields off ARGS. A unit test
 * asserts that no Lua constant in the codebase contains a template literal
 * interpolation, so the guarantee is enforced rather than merely documented.
 */

import { payloadTooLarge, protocolError, type BridgeError, type BridgeResult } from './errors.js';

/**
 * Ceiling on the encoded argument string. macOS caps the total argv size for a
 * process (ARG_MAX, around one megabyte), and blowing past it produces a
 * confusing E2BIG from the operating system rather than a useful message. A
 * quarter megabyte is far more than any legitimate tool call needs.
 */
export const MAX_ENCODED_ARG_BYTES = 256 * 1024;

export type LuaEnvelope =
  | { readonly ok: true; readonly value: unknown; readonly unencodable: boolean }
  | { readonly ok: false; readonly err: string };

export function encodeArgs(args: unknown): BridgeResult<string> {
  let json: string;
  try {
    json = JSON.stringify(args ?? {}) ?? '{}';
  } catch (cause) {
    return {
      ok: false,
      error: protocolError(
        'Tool arguments could not be serialised to JSON.',
        cause instanceof Error ? cause.message : String(cause)
      ),
    };
  }

  const encoded = Buffer.from(json, 'utf8').toString('base64');
  if (encoded.length > MAX_ENCODED_ARG_BYTES) {
    return { ok: false, error: payloadTooLarge(encoded.length, MAX_ENCODED_ARG_BYTES) };
  }

  return { ok: true, value: encoded };
}

/**
 * Wraps a static Lua body into a complete program.
 *
 * The body runs inside pcall so a Lua error becomes structured output instead
 * of a non-zero exit with a stack trace on stderr. The result is JSON-encoded
 * under a second pcall, because some Hammerspoon values (cyclic tables, for
 * instance) cannot be encoded, and losing the whole call to that is worse than
 * returning a stringified fallback.
 *
 * Local names are double-underscore prefixed so they cannot collide with
 * locals declared inside a tool body.
 */
export function buildProgram(luaBody: string, encodedArgs: string): string {
  return [
    `local ARGS = hs.json.decode(hs.base64.decode("${encodedArgs}")) or {}`,
    'local __ok, __res = pcall(function()',
    luaBody,
    'end)',
    'if not __ok then',
    '  return hs.json.encode({ ok = false, err = tostring(__res) })',
    'end',
    'local __encoded, __json = pcall(hs.json.encode, { ok = true, value = __res })',
    'if __encoded then return __json end',
    'return hs.json.encode({ ok = true, value = tostring(__res), unencodable = true })',
  ].join('\n');
}

/**
 * Extracts the envelope from raw stdout.
 *
 * The hs CLI prints extension load notices such as "-- Loading extension: json"
 * before the returned value, and those appear only on the first use of a module
 * in a session, so their presence is unpredictable. Rather than filtering by
 * prefix, the last line that parses as a valid envelope wins: the return value
 * is always printed last, and JSON encodes newlines inside strings, so a valid
 * envelope is always exactly one line.
 */
export function parseEnvelope(stdout: string): BridgeResult<LuaEnvelope> {
  const lines = stdout.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line === '' || !line.startsWith('{')) continue;

    const envelope = readEnvelope(line);
    if (envelope !== undefined) {
      return { ok: true, value: envelope };
    }
  }

  return {
    ok: false,
    error: protocolError(
      'Hammerspoon returned output that could not be parsed as a result envelope.',
      stdout.slice(0, 500)
    ),
  };
}

function readEnvelope(line: string): LuaEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record['ok'] !== 'boolean') return undefined;

  if (record['ok']) {
    return {
      ok: true,
      value: record['value'],
      unencodable: record['unencodable'] === true,
    };
  }

  return {
    ok: false,
    err: typeof record['err'] === 'string' ? record['err'] : 'unknown Lua error',
  };
}

/** Collapses an envelope into a bridge result. */
export function envelopeToResult(
  envelope: LuaEnvelope,
  toLuaError: (message: string) => BridgeError
): BridgeResult<unknown> {
  if (envelope.ok) return { ok: true, value: envelope.value };
  return { ok: false, error: toLuaError(envelope.err) };
}
