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
// string. acceptsInput is worth surfacing: passing input to a shortcut that
// does not accept any silently does nothing.
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

-- Shortcuts run asynchronously and their result is not returned to Lua, so
-- reporting "started" is the honest answer rather than implying completion.
hs.shortcuts.run(target, ARGS.input)
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
    "Run one of the user's macOS Shortcuts by name, optionally passing text input. Shortcuts run asynchronously, so this reports that it started rather than what it produced. Call hs_list_shortcuts first to get exact names.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(200)
      .describe('Shortcut name from hs_list_shortcuts. A substring is accepted.'),
    input: z.string().max(10_000).optional().describe('Optional text input for the shortcut.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(RUN_SHORTCUT_LUA, args)),
});
