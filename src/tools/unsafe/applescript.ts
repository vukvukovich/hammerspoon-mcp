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
const APPLESCRIPT_LUA = lua`
local ok, result, descriptor = hs.osascript.applescript(ARGS.script)

if not ok then
  -- The error descriptor carries the AppleScript error number and message,
  -- which is far more useful than a generic failure.
  local message = "AppleScript failed"
  if type(result) == "table" then
    message = message .. ": " .. tostring(result.NSLocalizedDescription or result.OSAScriptErrorMessage or "")
  elseif result ~= nil then
    message = message .. ": " .. tostring(result)
  end
  error(message, 0)
end

return { ok = true, result = result, type = descriptor and descriptor.type or nil }
`;

export const appleScriptTool = defineTool({
  name: 'hs_applescript',
  tier: 'unsafe',
  title: 'Run AppleScript',
  description:
    'Execute an AppleScript and return its result. This reaches applications that expose no other automation interface, such as Mail, Notes, Reminders, and Finder selections. It is arbitrary code execution with full user authority, which is why it is gated alongside hs_eval.',
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
