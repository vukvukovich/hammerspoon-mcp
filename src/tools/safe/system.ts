import { z } from 'zod';

import { defineTool, fromBridge, textResult } from '../registry.js';

const SCREENS_LUA = `
local out = {}
local primary = hs.screen.primaryScreen()
for _, s in ipairs(hs.screen.allScreens()) do
  local f = s:frame()
  local full = s:fullFrame()
  out[#out + 1] = {
    id = tostring(s:id()),
    name = s:name() or "",
    isPrimary = primary ~= nil and s:id() == primary:id(),
    frame = { x = f.x, y = f.y, w = f.w, h = f.h },
    fullFrame = { x = full.x, y = full.y, w = full.w, h = full.h },
  }
end
return out
`;

const CONSOLE_TAIL_LUA = `
local text = tostring(hs.console.getConsole() or "")
local lines = {}
for line in string.gmatch(text, "[^\\n]+") do
  lines[#lines + 1] = line
end
local wanted = ARGS.lines or 50
local first = math.max(1, #lines - wanted + 1)
local tail = {}
for i = first, #lines do
  tail[#tail + 1] = lines[i]
end
return { totalLines = #lines, returned = #tail, text = table.concat(tail, "\\n") }
`;

const NOTIFY_LUA = `
hs.alert.show(ARGS.text, ARGS.seconds or 2)
return { shown = true }
`;

/**
 * Reload is scheduled rather than immediate. hs.reload() tears down the Lua
 * state, and the IPC channel with it, so calling it inline kills the process
 * that is still trying to send us a reply. A short timer lets the reply leave
 * first.
 */
const RELOAD_LUA = `
hs.timer.doAfter(0.15, hs.reload)
return { scheduled = true }
`;

export const screensTool = defineTool({
  name: 'hs_screens',
  tier: 'safe',
  title: 'List screens',
  description:
    'List connected screens with their coordinate frames. frame excludes the menu bar and Dock, fullFrame includes them. Use these bounds when computing arguments for hs_move_window.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(SCREENS_LUA)),
});

export const consoleTailTool = defineTool({
  name: 'hs_console_tail',
  tier: 'safe',
  title: 'Read the Hammerspoon console',
  description:
    'Return the most recent lines from the Hammerspoon console. This is where Lua errors and print output from the user configuration appear, so it is the first place to look when a config change misbehaves.',
  inputSchema: z.object({
    lines: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe('How many trailing lines to return.'),
  }),
  annotations: { readOnlyHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(CONSOLE_TAIL_LUA, args)),
});

export const notifyTool = defineTool({
  name: 'hs_notify',
  tier: 'safe',
  title: 'Show an on-screen alert',
  description:
    'Display a transient alert on screen through Hammerspoon. Useful for telling the user something without stealing focus.',
  inputSchema: z.object({
    text: z.string().min(1).max(200).describe('Message to display.'),
    seconds: z.number().min(0.5).max(10).default(2).describe('How long the alert stays on screen.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(NOTIFY_LUA, args)),
});

export const reloadConfigTool = defineTool({
  name: 'hs_reload_config',
  tier: 'safe',
  title: 'Reload the Hammerspoon configuration',
  description:
    'Reload ~/.hammerspoon/init.lua. Use after editing the user configuration. The reload is scheduled a moment ahead so this call can return first, and it resets all in-memory state held by the configuration.',
  inputSchema: z.object({}),
  handler: async (_args, { bridge }) => {
    const result = await bridge.run(RELOAD_LUA);
    return fromBridge(result, () =>
      textResult(
        'Reload scheduled. Hammerspoon will restart its Lua state within a moment. If the configuration does not re-require hs.ipc, later tool calls will fail until it is loaded again.'
      )
    );
  },
});
