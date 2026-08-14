import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

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
// The parsed value is nil for anything Hammerspoon cannot turn into a Lua
// type (a date, for instance), and a nil silently vanishes from the encoded
// table, so the caller used to get a bare success carrying no value at all.
// There the raw form is the only thing left worth handing back.
const APPLESCRIPT_LUA = lua`
local ok, result, descriptor = hs.osascript.applescript(ARGS.script)

-- NSError descriptions arrive with non-ASCII escaped, so AppleScript's smart
-- quotes reach the caller as "Can\\U2019t divide". Put the characters back.
local function readable(text)
  local decoded = string.gsub(tostring(text), "\\\\U(%x%x%x%x)", function(hex)
    return utf8.char(tonumber(hex, 16))
  end)
  return decoded
end

if not ok then
  local message = "AppleScript failed"
  if type(descriptor) == "table" then
    local detail = descriptor.NSLocalizedDescription
      or descriptor.OSAScriptErrorMessageKey
      or descriptor.OSAScriptErrorBriefMessageKey
    if detail then message = message .. ": " .. readable(detail) end
    if descriptor.OSAScriptErrorNumberKey then
      message = message .. " (error " .. tostring(descriptor.OSAScriptErrorNumberKey) .. ")"
    end
  elseif result ~= nil then
    message = message .. ": " .. tostring(result)
  end
  error(message, 0)
end

local raw = type(descriptor) == "string" and descriptor or nil

if result == nil and raw ~= nil and raw ~= "" then
  return {
    ok = true,
    raw = raw,
    representable = false,
    hint = "AppleScript returned a value with no Lua equivalent, so only its raw form is available. Coerce it inside the script, for example: return (current date) as string",
  }
end

return { ok = true, result = result, representable = true }
`;

export const appleScriptTool = defineTool({
  name: 'hs_applescript',
  tier: 'unsafe',
  title: 'Run AppleScript',
  description:
    'Execute an AppleScript and return its result. This reaches applications that expose no other automation interface, such as Mail, Notes, Reminders, and Finder selections. Failures report the AppleScript error message and number. A result with no Lua equivalent (a date, for example) comes back as representable=false with its raw form, so coerce it in the script when you need the value. It is arbitrary code execution with full user authority, which is why it is gated alongside hs_eval.',
  inputSchema: z.object({
    script: z
      .string()
      .min(1)
      .max(50_000)
      .describe('AppleScript source. Use `tell application "Name" ... end tell` to target an app.'),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (args, { bridge }) =>
    fromBridge(await bridge.run(APPLESCRIPT_LUA, args, { timeoutMs: 30_000 })),
});
