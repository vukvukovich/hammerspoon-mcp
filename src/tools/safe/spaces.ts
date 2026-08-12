import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * Spaces are macOS virtual desktops. Hammerspoon indexes them by an opaque
 * numeric id that means nothing to a person, so these tools also expose a
 * stable 1-based position per screen, which is what a user actually says
 * ("desktop 2") and what the Ctrl+N keyboard shortcuts correspond to.
 */

const LIST_SPACES_LUA = lua`
local focused = hs.spaces.focusedSpace()
local names = hs.spaces.missionControlSpaceNames() or {}
local out = {}

for _, screen in ipairs(hs.screen.allScreens()) do
  local uuid = screen:getUUID()
  local ids = hs.spaces.allSpaces()[uuid] or {}
  local position = 0
  local screenNames = names[uuid] or {}

  for _, id in ipairs(ids) do
    local kind = hs.spaces.spaceType(id)
    -- Only user spaces get a position: fullscreen apps occupy a space too,
    -- but Ctrl+N does not address them, so numbering them would mislead.
    if kind == "user" then position = position + 1 end
    out[#out + 1] = {
      id = id,
      screen = screen:name() or "",
      screenUuid = uuid,
      type = kind,
      position = kind == "user" and position or nil,
      name = screenNames[id],
      isCurrent = id == focused,
    }
  end
end

return out
`;

const GOTO_SPACE_LUA = lua`
local target = ARGS.id

if target == nil then
  -- Resolve a 1-based user-space position on the main screen.
  local uuid = hs.screen.mainScreen():getUUID()
  local ids = hs.spaces.allSpaces()[uuid] or {}
  local seen = 0
  for _, id in ipairs(ids) do
    if hs.spaces.spaceType(id) == "user" then
      seen = seen + 1
      if seen == ARGS.position then target = id break end
    end
  end
  if target == nil then
    error("no user desktop at position " .. tostring(ARGS.position)
      .. " on the main screen, which has " .. tostring(seen), 0)
  end
end

if hs.spaces.focusedSpace() == target then
  return { id = target, alreadyThere = true }
end

local ok, err = hs.spaces.gotoSpace(target)
if not ok then error("could not switch: " .. tostring(err), 0) end

return { id = target, alreadyThere = false }
`;

export const listSpacesTool = defineTool({
  name: 'hs_list_spaces',
  tier: 'safe',
  title: 'List desktops (Spaces)',
  description:
    'List macOS Spaces across all screens with their id, type, and which one is current. User desktops also carry a 1-based position, which is the number people mean by "desktop 2" and what the Ctrl+N shortcuts match. Fullscreen app spaces have no position.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(LIST_SPACES_LUA)),
});

export const gotoSpaceTool = defineTool({
  name: 'hs_goto_space',
  tier: 'safe',
  title: 'Switch desktop (Space)',
  description:
    'Switch to another macOS desktop, either by its id from hs_list_spaces or by its 1-based position on the main screen. Switching animates, so give it a moment before acting on window positions.',
  inputSchema: z
    .object({
      id: z.number().int().optional().describe('Space id from hs_list_spaces.'),
      position: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .describe('1-based user desktop position on the main screen.'),
    })
    .refine((value) => (value.id === undefined) !== (value.position === undefined), {
      message: 'Provide exactly one of id or position.',
    }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(GOTO_SPACE_LUA, args)),
});
