import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * macOS Shortcuts.
 *
 * Worth having even though it looks like a thin wrapper: a Shortcut is
 * user-authored automation the person already trusts and named themselves, so
 * "run my Focus Mode shortcut" is both safe and something no other tool here
 * can do. It is effectively a user-defined extension point for the agent.
 */

// Each entry is a table of { id, name, acceptsInput, actionCount }, not a bare
// string. acceptsInput is still surfaced even though hs_run_shortcut cannot
// pass input (hs.shortcuts.run takes only a name): it tells the caller which
// shortcuts would need the Shortcuts app or CLI to be driven with input.
const LIST_SHORTCUTS_LUA = lua`
local entries = hs.shortcuts.list() or {}
local out = {}
for _, entry in ipairs(entries) do
  out[#out + 1] = {
    name = entry.name or "",
    id = entry.id or "",
    acceptsInput = entry.acceptsInput or false,
    actionCount = entry.actionCount,
  }
end
table.sort(out, function(a, b) return a.name < b.name end)
return { count = #out, shortcuts = out }
`;

const RUN_SHORTCUT_LUA = lua`
local entries = hs.shortcuts.list() or {}
local wanted = string.lower(ARGS.name)

local exact, partial, available = nil, nil, {}
for _, entry in ipairs(entries) do
  local name = entry.name or ""
  available[#available + 1] = name
  if string.lower(name) == wanted then exact = name break end
  if not partial and string.find(string.lower(name), wanted, 1, true) then partial = name end
end

local target = exact or partial
if not target then
  error("no shortcut named '" .. tostring(ARGS.name) .. "'. Available: "
    .. table.concat(available, ", "), 0)
end

-- hs.shortcuts.run would be the obvious call (and #15's arity fix alone would
-- make it compile), but it drives Shortcuts Events over synchronous
-- AppleScript, blocking Hammerspoon's main thread for the shortcut's entire
-- duration. Anything past ~4s trips the hs CLI's own receive timeout and
-- stalls every queued tool call behind it. hs.task runs the shortcuts CLI
-- asynchronously instead: argv so no shell parses the name, and the reply
-- leaves immediately. "--" keeps a name that starts with a dash from being
-- read as a flag.
local task = hs.task.new("/usr/bin/shortcuts", function(exitCode, _, stdErr)
  if exitCode ~= 0 then
    print("hs_run_shortcut: '" .. target .. "' exited " .. tostring(exitCode)
      .. ": " .. tostring(stdErr))
  end
end, { "run", "--", target })
if not task or task:start() == false then
  error("could not start /usr/bin/shortcuts", 0)
end

-- A started hs.task is killed if Lua collects it mid-run, so anchor it in a
-- namespaced global until it exits, pruning earlier finished runs.
__hsmcp_shortcut_tasks = __hsmcp_shortcut_tasks or {}
for i = #__hsmcp_shortcut_tasks, 1, -1 do
  if not __hsmcp_shortcut_tasks[i]:isRunning() then table.remove(__hsmcp_shortcut_tasks, i) end
end
__hsmcp_shortcut_tasks[#__hsmcp_shortcut_tasks + 1] = task

return { started = target, matchedExactly = exact ~= nil }
`;

export const listShortcutsTool = defineTool({
  name: 'hs_list_shortcuts',
  tier: 'safe',
  title: 'List macOS Shortcuts',
  description:
    "List the user's macOS Shortcuts by name. These are automations the user wrote themselves, so they are often the best way to do something specific to this machine.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(LIST_SHORTCUTS_LUA)),
});

export const runShortcutTool = defineTool({
  name: 'hs_run_shortcut',
  tier: 'safe',
  title: 'Run a macOS Shortcut',
  description:
    "Run one of the user's macOS Shortcuts by name. Input cannot be passed; a shortcut that needs input will run without it. The shortcut runs in the background, so this reports that it started rather than what it produced; a shortcut that fails after starting logs to the console, visible via hs_console_tail. Call hs_list_shortcuts first to get exact names.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(200)
      .describe('Shortcut name from hs_list_shortcuts. A substring is accepted.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(RUN_SHORTCUT_LUA, args)),
});
