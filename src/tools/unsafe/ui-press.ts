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
-- Matches hs_ui_inspect's fallback order, so the label a caller read there is
-- the label compared here. An empty string is "no label", not a label.
local function labelled(name)
  local value = element:attributeValue(name)
  if type(value) == "string" and value ~= "" then return value end
  return nil
end
local label = labelled("AXTitle") or labelled("AXDescription") or labelled("AXLabel")

-- Identity check, and the reason this tool is not merely a path walker (#27).
-- A path that still resolves is not a path that still means what it meant:
-- pressing an element frequently reshapes the tree around it (Calculator
-- inserts a Delete button once its display has input, shifting every later
-- sibling by one), so the second press planned from one inspection lands on
-- the wrong element. Validity is not identity, so compare before acting.
if ARGS.expectLabel ~= nil and label ~= ARGS.expectLabel then
  error("refusing to act: expected the element at " .. ARGS.path .. " to be labelled '"
    .. tostring(ARGS.expectLabel) .. "', found " .. (label and ("'" .. label .. "'") or "no label")
    .. ". Pressing reshapes the tree, so re-run hs_ui_inspect for current paths.", 0)
end
if ARGS.expectRole ~= nil and role ~= ARGS.expectRole then
  error("refusing to act: expected the element at " .. ARGS.path .. " to be a "
    .. tostring(ARGS.expectRole) .. ", found " .. role
    .. ". Pressing reshapes the tree, so re-run hs_ui_inspect for current paths.", 0)
end

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

return {
  app = app:name(),
  path = ARGS.path,
  role = role,
  label = label,
  action = wanted,
  -- False means nothing was checked against the caller's expectation, so the
  -- element pressed is whatever the path happened to resolve to just now.
  verified = ARGS.expectLabel ~= nil or ARGS.expectRole ~= nil,
}
`;

export const pressUiTool = defineTool({
  name: 'hs_ui_press',
  tier: 'unsafe',
  title: 'Press a UI element',
  description:
    'Perform an accessibility action on an element found by hs_ui_inspect, usually pressing a button. This acts with the full authority of the user in any application. ALWAYS pass expectLabel (the label hs_ui_inspect reported for that path): pressing an element frequently reshapes the tree around it, so paths from an earlier inspection can silently point at a different element, and expectLabel is what turns that into a refusal instead of a wrong click. Re-run hs_ui_inspect after each press rather than reusing paths from before it.',
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[0-9/]+$/, 'A path is a slash-separated list of child indexes, such as /1/3/2.')
      .describe('Element path from hs_ui_inspect, for example "/1/3/2".'),
    expectLabel: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'The label hs_ui_inspect reported for this path. The press is refused if the element there no longer carries it. Omit only for elements that have no label.'
      ),
    expectRole: z
      .string()
      .min(2)
      .max(40)
      .optional()
      .describe(
        'The role hs_ui_inspect reported, for example "AXButton". Use this when the element has no label. The press is refused on a mismatch.'
      ),
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
