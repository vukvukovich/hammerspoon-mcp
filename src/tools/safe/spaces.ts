import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge, jsonResult } from '../registry.js';

import type { ToolContext } from '../registry.js';

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

// Switching mechanism, verified on macOS 26: hs.spaces.gotoSpace() returns
// true ("initiated") and then does nothing at all, because its Mission
// Control button-press internals no longer work. What does work is the
// user-level keyboard shortcut: a synthetic Ctrl+<digit> keystroke switches
// directly to that desktop when the "Switch to Desktop N" shortcut is enabled
// (macOS enables them as desktops are created). Positions past 9 have no
// digit, so those fall back to gotoSpace and rely on the read-back to tell
// the truth. The handler verifies arrival either way.
const GOTO_SPACE_LUA = lua`
local target = ARGS.id
local position = nil

-- Desktop numbering is global across screens in display order, which is what
-- the Ctrl+N shortcuts address.
local seen = 0
for _, screen in ipairs(hs.screen.allScreens()) do
  local ids = hs.spaces.allSpaces()[screen:getUUID()] or {}
  for _, id in ipairs(ids) do
    if hs.spaces.spaceType(id) == "user" then
      seen = seen + 1
      if target ~= nil and id == target then position = seen end
      if target == nil and seen == ARGS.position then target = id position = seen end
    end
  end
end

if target == nil then
  error("no user desktop at position " .. tostring(ARGS.position)
    .. "; there are " .. tostring(seen) .. " desktops", 0)
end
if position == nil then
  error("no user desktop has id " .. tostring(target)
    .. ". Call hs_list_spaces for current ids; they change when macOS rearranges Spaces", 0)
end

if hs.spaces.focusedSpace() == target then
  return { id = target, position = position, alreadyThere = true }
end

if position <= 9 then
  hs.eventtap.keyStroke({ "ctrl" }, tostring(position))
  return { id = target, position = position, method = "keystroke" }
end

local ok, err = hs.spaces.gotoSpace(target)
if not ok then error("could not switch: " .. tostring(err), 0) end
return { id = target, position = position, method = "gotoSpace" }
`;

const FOCUSED_SPACE_LUA = lua`
return { focused = hs.spaces.focusedSpace() }
`;

const GOTO_RESULT_SCHEMA = z.object({
  id: z.number(),
  position: z.number(),
  alreadyThere: z.boolean().optional(),
  method: z.string().optional(),
});

const FOCUSED_SCHEMA = z.object({ focused: z.number() });

/** The Mission Control slide animation takes roughly half a second; poll
 * rather than sleep a fixed worst case so the common case stays fast. */
const SPACE_POLL_MS = 200;
const SPACE_POLL_BUDGET_MS = 1600;

async function waitForSpace(
  bridge: ToolContext['bridge'],
  targetId: number
): Promise<number | undefined> {
  const deadline = Date.now() + SPACE_POLL_BUDGET_MS;
  let last: number | undefined;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SPACE_POLL_MS));
    const read = await bridge.run(FOCUSED_SPACE_LUA);
    if (read.ok) {
      const parsed = FOCUSED_SCHEMA.safeParse(read.value);
      if (parsed.success) {
        last = parsed.data.focused;
        if (last === targetId) return last;
      }
    }
    if (Date.now() >= deadline) return last;
  }
}

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
    'Switch to another macOS desktop, either by its id from hs_list_spaces or by its 1-based position. The result reports where the switch actually landed: arrived=false with landedOn set means the system did not end up on the requested desktop, which can happen when macOS auto-rearranges Spaces mid-switch. Verified, not assumed.',
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
  handler: async (args, { bridge }) => {
    const first = await bridge.run(GOTO_SPACE_LUA, args);
    if (!first.ok) return fromBridge(first);
    const parsed = GOTO_RESULT_SCHEMA.safeParse(first.value);
    if (!parsed.success) return fromBridge(first);

    const target = parsed.data;
    if (target.alreadyThere === true) {
      return jsonResult({ id: target.id, position: target.position, alreadyThere: true });
    }

    let landed = await waitForSpace(bridge, target.id);

    // One retry: macOS occasionally swallows the first keystroke while it is
    // still animating something else, and rearranged Spaces can shift the
    // digit a target answers to, which the rerun recomputes from fresh state.
    if (landed !== target.id) {
      const second = await bridge.run(GOTO_SPACE_LUA, args);
      if (second.ok) landed = await waitForSpace(bridge, target.id);
    }

    const arrived = landed === target.id;
    return jsonResult({
      id: target.id,
      position: target.position,
      arrived,
      ...(arrived ? {} : { landedOn: landed ?? null }),
      alreadyThere: false,
    });
  },
});
