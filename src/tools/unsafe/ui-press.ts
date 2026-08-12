import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * Performing an accessibility action, which means clicking things.
 *
 * Gated, and the reasoning is worth stating plainly. Reading the UI tree is
 * inspection. Pressing an element is acting as the user, with the user's full
 * authority over every running application. It can press Send on a draft,
 * Delete on a file, or Allow on a security prompt.
 *
 * That is the same class of power as synthesising keystrokes, which this
 * server refuses at every tier. The difference is that pressing a named,
 * inspected element is far more predictable than blind typing, which is why it
 * exists at all rather than being excluded outright.
 *
 * Known coarseness: the tier system is safe-or-all today, so unlocking this
 * also unlocks hs_eval. A third tier would let someone allow UI automation
 * without allowing arbitrary Lua. Worth doing if anyone asks.
 */
const PRESS_LUA = lua`
local app
if ARGS.app then
  app = hs.application.find(ARGS.app)
  if not app then error("no running application matches '" .. tostring(ARGS.app) .. "'", 0) end
else
  app = hs.application.frontmostApplication()
  if not app then error("no application is frontmost", 0) end
end

local element = hs.axuielement.applicationElement(app)
if not element then
  error("could not read the accessibility tree for " .. (app:name() or "?"), 0)
end

-- The path is the child-index trail hs_ui_inspect reported, "/1/3/2". Walking
-- it again rather than holding a handle keeps this stateless, and it means a
-- stale path fails loudly instead of acting on the wrong element.
local steps = {}
for step in string.gmatch(ARGS.path, "[^/]+") do steps[#steps + 1] = tonumber(step) end
if #steps == 0 then error("path '" .. tostring(ARGS.path) .. "' selects no element", 0) end

for depth, index in ipairs(steps) do
  local children = element:attributeValue("AXChildren")
  if type(children) ~= "table" or children[index] == nil then
    error("path stops being valid at step " .. tostring(depth) .. " (index " .. tostring(index)
      .. "). The UI changed since it was inspected, so re-run hs_ui_inspect.", 0)
  end
  element = children[index]
end

local role = element:attributeValue("AXRole") or "?"
local label = element:attributeValue("AXTitle") or element:attributeValue("AXDescription")

local available = element:actionNames() or {}
local wanted = ARGS.action or "AXPress"
local supported = false
for _, name in ipairs(available) do
  if name == wanted then supported = true break end
end
if not supported then
  error("the element at " .. ARGS.path .. " (" .. role .. ") does not support "
    .. wanted .. ". It supports: " .. (#available > 0 and table.concat(available, ", ") or "nothing"), 0)
end

local ok, err = pcall(function() return element:performAction(wanted) end)
if not ok then error("performing " .. wanted .. " failed: " .. tostring(err), 0) end

return { app = app:name(), path = ARGS.path, role = role, label = label, action = wanted }
`;

export const pressUiTool = defineTool({
  name: 'hs_ui_press',
  tier: 'unsafe',
  title: 'Press a UI element',
  description:
    'Perform an accessibility action on an element found by hs_ui_inspect, usually pressing a button. This acts with the full authority of the user in any application, so confirm the element is the intended one before calling. The path comes from hs_ui_inspect and is re-walked each time, so a path that no longer resolves fails rather than pressing something else.',
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[0-9/]+$/, 'A path is a slash-separated list of child indexes, such as /1/3/2.')
      .describe('Element path from hs_ui_inspect, for example "/1/3/2".'),
    app: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Application name. Must match the one the path was inspected in.'),
    action: z
      .string()
      .min(3)
      .max(40)
      .default('AXPress')
      .describe('Accessibility action name. hs_ui_inspect lists what each element supports.'),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(PRESS_LUA, args)),
});
