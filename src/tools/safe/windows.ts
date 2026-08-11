import { z } from 'zod';

import { defineTool, fromBridge } from '../registry.js';
import { lua } from '../../bridge/lua.js';

/**
 * All Lua in this file is a static constant. Arguments arrive through the ARGS
 * table produced by the codec, never by interpolation. See src/bridge/codec.ts.
 */

const LIST_WINDOWS_LUA = lua`
local filter = ARGS.app
if filter then filter = string.lower(filter) end
local out = {}
for _, w in ipairs(hs.window.allWindows()) do
  local app = w:application()
  local name = app and app:name() or ""
  if (not filter) or string.find(string.lower(name), filter, 1, true) then
    local id = w:id()
    if id then
      local f = w:frame()
      local screen = w:screen()
      out[#out + 1] = {
        id = id,
        app = name,
        title = w:title() or "",
        frame = { x = f.x, y = f.y, w = f.w, h = f.h },
        screen = screen and screen:name() or nil,
        isMinimized = w:isMinimized(),
      }
    end
  end
end
return out
`;

const FOCUS_WINDOW_LUA = lua`
local target
if ARGS.id then
  target = hs.window.get(ARGS.id)
  if not target then error("no window has id " .. tostring(ARGS.id), 0) end
else
  target = hs.window.find(ARGS.title)
  if not target then error("no window title contains " .. tostring(ARGS.title), 0) end
end
target:focus()
local app = target:application()
return {
  id = target:id(),
  app = app and app:name() or "",
  title = target:title() or "",
}
`;

const MOVE_WINDOW_LUA = lua`
local target = hs.window.get(ARGS.id)
if not target then error("no window has id " .. tostring(ARGS.id), 0) end
local f = target:frame()
if ARGS.x then f.x = ARGS.x end
if ARGS.y then f.y = ARGS.y end
if ARGS.width then f.w = ARGS.width end
if ARGS.height then f.h = ARGS.height end
target:setFrame(f)
local moved = target:frame()
return {
  id = target:id(),
  frame = { x = moved.x, y = moved.y, w = moved.w, h = moved.h },
}
`;

export const listWindowsTool = defineTool({
  name: 'hs_list_windows',
  tier: 'safe',
  title: 'List windows',
  description:
    'List every visible window with its id, owning application, title, frame, and screen. Window ids are what hs_focus_window and hs_move_window operate on, so call this first.',
  inputSchema: z.object({
    app: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only return windows whose application name contains this text, case-insensitive.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(LIST_WINDOWS_LUA, args)),
});

export const focusWindowTool = defineTool({
  name: 'hs_focus_window',
  tier: 'safe',
  title: 'Focus a window',
  description:
    'Bring a window to the front, selected by id (exact) or by a substring of its title. The matched window is returned so you can confirm the right one was chosen.',
  inputSchema: z
    .object({
      id: z.number().int().optional().describe('Window id from hs_list_windows.'),
      title: z.string().min(1).max(200).optional().describe('Substring of the window title.'),
    })
    // Requiring exactly one avoids a silent precedence rule that the caller
    // cannot see. An ambiguous request is a caller bug, so it fails loudly.
    .refine((value) => (value.id === undefined) !== (value.title === undefined), {
      message: 'Provide exactly one of id or title.',
    }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(FOCUS_WINDOW_LUA, args)),
});

export const moveWindowTool = defineTool({
  name: 'hs_move_window',
  tier: 'safe',
  title: 'Move or resize a window',
  description:
    'Set the position and/or size of a window by id, in screen pixels. Omitted fields keep their current value. Use hs_screens to learn the available coordinate space.',
  inputSchema: z
    .object({
      id: z.number().int().describe('Window id from hs_list_windows.'),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    })
    .refine(
      (value) =>
        value.x !== undefined ||
        value.y !== undefined ||
        value.width !== undefined ||
        value.height !== undefined,
      { message: 'Provide at least one of x, y, width, or height.' }
    ),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(MOVE_WINDOW_LUA, args)),
});
