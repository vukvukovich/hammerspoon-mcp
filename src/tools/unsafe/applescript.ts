import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import {
  defineTool,
  fromBridge,
  jsonResult,
  unrepresentableResult,
  type ToolContext,
} from '../registry.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Running AppleScript. Gated, for the same reason hs_eval is.
 *
 * AppleScript is a scripting language with full access to every scriptable
 * application and to `do shell script`. It is arbitrary code execution wearing
 * different syntax, so it belongs in the same tier as hs_eval rather than
 * looking safer because it reads like English.
 *
 * It earns its place despite that: a great deal of macOS automation only
 * exists through AppleScript dictionaries (Mail, Notes, Reminders, Finder
 * selections, many third party apps), and none of it is reachable through
 * Hammerspoon's own modules.
 *
 * The script travels through the ARGS codec like every other argument, so the
 * program itself is still a static constant and the codec invariant holds.
 */
// hs.osascript.applescript returns THREE values: ok, the parsed result, and a
// descriptor. Which of the last two carries the useful information depends on
// ok, and reading the wrong one is what made every failure report a bare
// "AppleScript failed" (#28):
//
//   failure: result is nil, descriptor is the error dictionary
//   success: result is the parsed value, descriptor is its raw source form
//
// Two raw forms mean "no value", not "unrepresentable value" (#32): "null()"
// is a script that returned nothing (most action-only scripts), and "'msng'"
// is AppleScript's own null, `missing value`. Both are successes with a null
// result. Only a raw form beyond those marks a value Hammerspoon genuinely
// could not turn into a Lua type (a date, raw event data), where the raw form
// is the only thing left worth handing back.
//
// Error text arrives with non-ASCII escaped NSString-style ("Can\U2019t").
// Decoding lives in TypeScript (decodeNsStringEscapes below), where surrogate
// pairs can be handled correctly and the logic is unit-testable; the Lua side
// passes the text through untouched.
const APPLESCRIPT_LUA = lua`
local ok, result, descriptor = hs.osascript.applescript(ARGS.script)

if not ok then
  local message = "AppleScript failed"
  if type(descriptor) == "table" then
    local detail = descriptor.NSLocalizedDescription
      or descriptor.OSAScriptErrorMessageKey
      or descriptor.OSAScriptErrorBriefMessageKey
    if detail then
      message = message .. ": " .. tostring(detail)
      if descriptor.OSAScriptErrorNumberKey then
        message = message .. " (error " .. tostring(descriptor.OSAScriptErrorNumberKey) .. ")"
      end
    else
      -- None of the known keys. Surface whatever the dictionary carries
      -- rather than discarding the diagnosis (#32): scalar values verbatim
      -- (userdata event descriptors are skipped, their tostring is a page of
      -- hex), and bare key names when no value is scalar - the key set alone
      -- says which error family this is.
      local parts = {}
      for key, value in pairs(descriptor) do
        local kind = type(value)
        if kind == "string" or kind == "number" or kind == "boolean" then
          parts[#parts + 1] = tostring(key) .. "=" .. tostring(value)
        end
      end
      if #parts == 0 then
        for key in pairs(descriptor) do parts[#parts + 1] = tostring(key) end
      end
      table.sort(parts)
      if #parts > 0 then
        message = message .. ": " .. table.concat(parts, "; ")
      end
    end
  elseif descriptor ~= nil and tostring(descriptor) ~= "" then
    -- Defensive: the documented failure shape is a table, but a string
    -- descriptor is still a diagnostic worth more than a bare message.
    message = message .. ": " .. tostring(descriptor)
  end
  error(message, 0)
end

local raw = type(descriptor) == "string" and descriptor or nil

-- Every wrapper this program hands back must survive the codec's encode, or
-- the codec tostrings the WRAPPER table and the caller gets a pointer it
-- never created. So each candidate is probed before being returned, and the
-- raw form gets the same treatment as the parsed result: it describes the
-- same bytes that may just have refused to encode.
local function encodable(wrapper)
  local fine, encoded = pcall(hs.json.encode, wrapper)
  if fine and encoded ~= nil then return wrapper end
  return nil
end

-- "null()" is a script that returned nothing; "'msng'" is missing value,
-- AppleScript's own null. Exact spellings, verified live. The exactness is a
-- known shelf-life risk: if a future build renders the empty descriptor
-- differently, the symptom is action-only scripts misreported as
-- unrepresentable - extend this pair, do not loosen the nil-result check
-- (a genuine date also has a nil result and MUST stay flagged).
if result == nil and raw ~= nil and raw ~= "" and raw ~= "null()" and raw ~= "'msng'" then
  return encodable({ ok = true, raw = raw }) or { ok = true, rawUnavailable = true }
end

if result ~= nil then
  -- The probe costs one extra serialisation of the result, which is the
  -- price of never shipping a wrapper pointer; action-only and null results
  -- skip it entirely.
  local plain = encodable({ ok = true, result = result })
  if plain then return plain end
  local viaRaw = (raw ~= nil and raw ~= "") and encodable({ ok = true, raw = raw }) or nil
  if viaRaw then return viaRaw end
  -- No representable form at all. Say exactly that, with no fabricated
  -- stand-in value that could be mistaken for a genuine descriptor.
  return { ok = true, rawUnavailable = true }
end

-- Reachable only when result is nil (every result ~= nil path above
-- returns), so this is a null success and says exactly that.
return { ok = true }
`;

/**
 * Decodes NSString-style escapes in AppleScript error text.
 *
 * NSError descriptions escape non-ASCII as \\Uxxxx per UTF-16 code unit, so a
 * character outside the Basic Multilingual Plane arrives as TWO escapes (a
 * surrogate pair) that must be decoded together; decoding them separately
 * produces invalid UTF-8, which is how #32 mangled emoji in error messages. A
 * literal backslash in the original text arrives doubled ("\\\\"), verified
 * live, which is what makes decoding exact rather than heuristic: "\\\\U0041"
 * is the four literal characters \\U0041, not an escape.
 *
 * An escape that decodes to an unpaired surrogate is left as literal text:
 * emitting half a character is worse than showing the escape.
 *
 * The doubling rule is verified for NSError description text. The unknown-key
 * dump branch feeds raw dictionary values through here too, where doubling is
 * unverified; a genuine backslash in such a value may decode wrongly. Accepted:
 * that path is already a degraded diagnostic, and guessing would corrupt the
 * common case to protect the rare one.
 */
export function decodeNsStringEscapes(text: string): string {
  return text.replace(
    // Ordered alternation: a doubled backslash first (so it can never be
    // read as starting an escape), then a full surrogate pair, then a
    // single escape.
    /\\\\|\\U([Dd][89ABab][0-9A-Fa-f]{2})\\U([Dd][C-Fc-f][0-9A-Fa-f]{2})|\\U([0-9A-Fa-f]{4})/g,
    (match, high: string | undefined, low: string | undefined, single: string | undefined) => {
      if (match === '\\\\') return '\\';
      if (high !== undefined && low !== undefined) {
        return String.fromCharCode(parseInt(high, 16), parseInt(low, 16));
      }
      if (single !== undefined) {
        const unit = parseInt(single, 16);
        // An unpaired surrogate half: leave the escape visible.
        if (unit >= 0xd800 && unit <= 0xdfff) return match;
        return String.fromCharCode(unit);
      }
      return match;
    }
  );
}

const RAW_RESULT_HINT =
  'AppleScript returned a value Hammerspoon could not turn into a Lua type, so only its raw source form is shown. Coerce it inside the script when you need the value, for example: return (current date) as string';

// Distinct from RAW_RESULT_HINT because the diagnosis differs: here the value
// existed but no readable form of it survived, and coercing to a plain type
// is the only way to get anything out.
const NO_RAW_HINT =
  'The script succeeded, but its result could not be represented and no readable raw form was available either. If you need the value, coerce it to a plain type inside the script, for example: return (theResult as string)';

function renderAppleScriptResult(value: unknown): CallToolResult {
  const record = value as { raw?: unknown; rawUnavailable?: unknown } | null;
  if (record !== null && typeof record === 'object') {
    // { ok: true } rides along because this tool's plain successes carry ok,
    // and it must not vanish on exactly the degraded payloads (#35).
    if (typeof record.raw === 'string') {
      return unrepresentableResult(record.raw, RAW_RESULT_HINT, { ok: true });
    }
    if (record.rawUnavailable === true) {
      return unrepresentableResult(null, NO_RAW_HINT, { ok: true });
    }
  }
  return jsonResult(value);
}

async function runAppleScript(
  args: { script: string },
  { bridge }: ToolContext
): Promise<CallToolResult> {
  const result = await bridge.run(APPLESCRIPT_LUA, args, { timeoutMs: 30_000 });
  // Decode NSString escapes only in messages the AppleScript failure branch
  // built (recognisable by its prefix): other Lua errors never went through
  // NSString escaping, and decoding them would corrupt genuine backslashes.
  // The rewritten error keeps its kind, hint, and detail, and renders through
  // fromBridge like every other tool's failure.
  if (
    !result.ok &&
    result.error.kind === 'LuaError' &&
    result.error.message.startsWith('AppleScript failed')
  ) {
    return fromBridge(
      {
        ok: false,
        error: { ...result.error, message: decodeNsStringEscapes(result.error.message) },
      },
      renderAppleScriptResult
    );
  }
  return fromBridge(result, renderAppleScriptResult);
}

export const appleScriptTool = defineTool({
  name: 'hs_applescript',
  tier: 'unsafe',
  title: 'Run AppleScript',
  description:
    'Execute an AppleScript and return its result. This reaches applications that expose no other automation interface, such as Mail, Notes, Reminders, and Finder selections. Failures report the AppleScript error message and number. A script that returns nothing (or missing value) reports a plain success with no result. A result with no Lua equivalent (a date, for example) comes back as encodable=false with its raw form, so coerce it in the script when you need the value. It is arbitrary code execution with full user authority, which is why it is gated alongside hs_eval.',
  inputSchema: z.object({
    script: z
      .string()
      .min(1)
      .max(50_000)
      .describe('AppleScript source. Use `tell application "Name" ... end tell` to target an app.'),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: runAppleScript,
});
