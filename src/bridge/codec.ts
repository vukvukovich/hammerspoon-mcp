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
 * interpolation. That check is the second layer. The first is the type system:
 * bridge.run accepts only a LuaProgram, and the only way to make one is the
 * `lua` template tag, whose signature cannot express an interpolation. See
 * src/bridge/lua.ts.
 */

import { randomBytes } from 'node:crypto';

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
  try {
    const json = JSON.stringify(args ?? {}) ?? '{}';

    // Measure before encoding, not after. Base64 grows input by a third, and
    // past V8's string cap toString('base64') throws ERR_STRING_TOO_LONG
    // rather than returning something measurable. That escaped this function
    // as an uncaught throw even though the signature promises a BridgeResult.
    const encodedLength = Math.ceil(json.length / 3) * 4;
    if (encodedLength > MAX_ENCODED_ARG_BYTES) {
      return { ok: false, error: payloadTooLarge(encodedLength, MAX_ENCODED_ARG_BYTES) };
    }

    return { ok: true, value: Buffer.from(json, 'utf8').toString('base64') };
  } catch (cause) {
    return {
      ok: false,
      error: protocolError(
        'Tool arguments could not be serialised to JSON.',
        cause instanceof Error ? cause.message : String(cause)
      ),
    };
  }
}

/**
 * A fresh unguessable marker for one call's result line.
 *
 * stdout is not a private channel. LuaSkin writes its own errors there (not to
 * stderr), and those messages interpolate the offending value verbatim. So a
 * tool argument used as a table key reaches stdout unescaped, and an argument
 * containing newlines can print a line that looks exactly like a result
 * envelope. Combined with an encode failure, which removes the real envelope,
 * "the last line that parses as JSON" would pick the forged one and hand the
 * caller an attacker-chosen result.
 *
 * A fixed sentinel would not help: the attacker controls the echoed text and
 * would simply include it. The marker has to be unpredictable and different
 * every call, so it cannot appear in an argument composed before it existed.
 */
export function newResultMarker(): string {
  return `HSMCP${randomBytes(8).toString('hex')}`;
}

/**
 * Wraps a static Lua body into a complete program.
 *
 * The body runs inside pcall so a Lua error becomes structured output instead
 * of a non-zero exit with a stack trace on stderr.
 *
 * The result line is prefixed with the caller's per-call marker so the parser
 * can tell our output apart from anything else that reaches stdout. See
 * newResultMarker for why that is necessary.
 *
 * Encoding failure is detected by testing for nil, NOT by pcall. hs.json.encode
 * RETURNS nil on values it cannot represent (userdata, functions, cyclic
 * tables) rather than raising, so a pcall around it reports success with a nil
 * result. The previous version therefore returned nothing at all in exactly
 * the case its fallback was written to handle, which is what let a forged line
 * become the last parseable one.
 *
 * Local names are double-underscore prefixed so they cannot collide with
 * locals declared inside a tool body.
 */
export function buildProgram(luaBody: string, encodedArgs: string, marker: string): string {
  return [
    `local ARGS = hs.json.decode(hs.base64.decode("${encodedArgs}")) or {}`,
    'local __ok, __res = pcall(function()',
    luaBody,
    'end)',
    // tostring must run inside its own pcall: it is evaluated while building
    // the encode argument, before the pcall around hs.json.encode protects
    // anything, and a __tostring metamethod can throw (#34). Unprotected, that
    // raised at chunk top level, printed no marker line, and surfaced as a
    // ProtocolError instead of the report this fallback exists to produce.
    'local function __stringify(value, fallback)',
    '  local ok, text = pcall(tostring, value)',
    '  if ok and type(text) == "string" then return text end',
    '  return fallback',
    'end',
    'local __payload',
    'if __ok then',
    '  local __fine, __encoded = pcall(hs.json.encode, { ok = true, value = __res })',
    '  if __fine and __encoded ~= nil then',
    '    __payload = __encoded',
    '  else',
    '    local __str = __stringify(__res, "value whose tostring also failed")',
    '    local __ok2, __alt = pcall(hs.json.encode, { ok = true, value = __str, unencodable = true })',
    '    __payload = (__ok2 and __alt) or nil',
    '  end',
    'else',
    '  local __err = __stringify(__res, "error value whose tostring failed")',
    '  local __ok3, __errJson = pcall(hs.json.encode, { ok = false, err = __err })',
    '  __payload = (__ok3 and __errJson) or nil',
    'end',
    'if __payload == nil then',
    '  __payload = "{\\"ok\\":false,\\"err\\":\\"result could not be encoded\\"}"',
    'end',
    `return "${marker}" .. __payload`,
  ].join('\n');
}

/**
 * Extracts the envelope from raw stdout.
 *
 * Only a line carrying this call's marker is considered. That matters more
 * than it looks: the hs CLI prints extension load notices, and LuaSkin prints
 * its own errors to stdout with the offending value interpolated verbatim, so
 * stdout carries text an attacker can influence. Accepting "the last line that
 * happens to parse as JSON" let a crafted argument forge a result. The marker
 * is generated per call and cannot be predicted by whoever supplied the
 * arguments.
 */
export function parseEnvelope(stdout: string, marker: string): BridgeResult<LuaEnvelope> {
  const lines = stdout.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith(marker)) continue;

    const envelope = readEnvelope(line.slice(marker.length));
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
  if (envelope.ok) {
    // Only set when true: a plain success must stay { ok, value }, which is
    // what callers and tests compare against.
    return envelope.unencodable
      ? { ok: true, value: envelope.value, unencodable: true }
      : { ok: true, value: envelope.value };
  }
  return { ok: false, error: toLuaError(envelope.err) };
}
