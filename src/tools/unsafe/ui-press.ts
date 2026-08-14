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

-- pcall because this walk runs on caller-supplied paths into a tree that may
-- have changed: a dead element's attributeValue raises inside LuaSkin, and a
-- raise means the same thing a missing child does - the path went stale.
for depth, index in ipairs(steps) do
  local okChildren, children = pcall(function() return element:attributeValue("AXChildren") end)
  if not okChildren or type(children) ~= "table" or children[index] == nil then
    error("path stops being valid at step " .. tostring(depth) .. " (index " .. tostring(index)
      .. "). The UI changed since it was inspected, so re-run hs_ui_inspect.", 0)
  end
  element = children[index]
end

-- The label compared against expectLabel MUST be the label hs_ui_inspect
-- reported, or the guard refuses correct presses forever (#31). The two
-- functions below are a byte-identical copy of the ones in
-- src/tools/safe/accessibility.ts; the lua tag forbids sharing them as a
-- fragment, so a unit test pins the copies to each other instead.

-- An empty string is "no label", not a label: Chrome sets AXTitle to "" on
-- most controls and keeps the real name in AXDescription, and Lua's truthiness
-- would stop the fallback chain at the "" (#18).
local function attr(element, name)
  local ok, value = pcall(function() return element:attributeValue(name) end)
  if ok and type(value) == "string" and value ~= "" then return value end
  return nil
end

-- A person recognises an element by whatever label it happens to carry, and
-- different apps populate different attributes, so fall through them in order.
local function labelOf(element)
  return attr(element, "AXTitle")
    or attr(element, "AXDescription")
    or attr(element, "AXLabel")
    or attr(element, "AXHelp")
    or attr(element, "AXPlaceholderValue")
end

local role = attr(element, "AXRole") or "?"
local label = labelOf(element)

-- Identity check, and the reason this tool is not merely a path walker (#27).
-- A path that still resolves is not a path that still means what it meant:
-- pressing an element frequently reshapes the tree around it (Calculator
-- inserts a Delete button once its display has input, shifting every later
-- sibling by one), so the second press planned from one inspection lands on
-- the wrong element. Validity is not identity, so compare before acting.
-- The schema requires an expectation, but this program must not trust its
-- caller either: a direct bridge.run with neither would otherwise press
-- unchecked and still claim a verification level below (#36).
if ARGS.expectLabel == nil and ARGS.expectRole == nil then
  error("refusing to act: pass expectLabel (the label hs_ui_inspect reported for this path)"
    .. " or, for unlabelled elements, expectRole. Without one, a press lands on whatever the"
    .. " path resolves to now, which is not necessarily the element that was inspected.", 0)
end
local function refuse(expected, found)
  error("refusing to act: expected the element at " .. ARGS.path .. " to be " .. expected
    .. ", found " .. found
    .. ". Pressing reshapes the tree, so re-run hs_ui_inspect for current paths.", 0)
end
if ARGS.expectLabel ~= nil and label ~= ARGS.expectLabel then
  refuse("labelled '" .. tostring(ARGS.expectLabel) .. "'",
    label and ("'" .. label .. "'") or "no label")
end
if ARGS.expectRole ~= nil and role ~= ARGS.expectRole then
  refuse("a " .. tostring(ARGS.expectRole), role)
end

local okActions, available = pcall(function() return element:actionNames() end)
if not okActions or type(available) ~= "table" then available = {} end
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
  -- What the press was checked against. "label" is an identity check;
  -- "role" only proves the element is the same KIND as expected, which every
  -- sibling in a keypad or toolbar also is (#36). Each arm is derived from
  -- its own expectation being present - never from the other's absence - and
  -- the guard above makes an unchecked press unreachable.
  verified = (ARGS.expectLabel ~= nil and "label") or (ARGS.expectRole ~= nil and "role") or nil,
}
`;

export const pressUiTool = defineTool({
  name: 'hs_ui_press',
  tier: 'unsafe',
  title: 'Press a UI element',
  description:
    'Perform an accessibility action on an element found by hs_ui_inspect, usually pressing a button. This acts with the full authority of the user in any application. At least one of expectLabel or expectRole is required: pressing an element frequently reshapes the tree around it, so paths from an earlier inspection can silently point at a different element, and the expectation is what turns that into a refusal instead of a wrong click. Pass expectLabel (the label hs_ui_inspect reported) whenever the element has one; expectRole alone only proves the element is the same kind, not the same element. Re-run hs_ui_inspect after each press rather than reusing paths from before it.',
  inputSchema: z
    .object({
      path: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[0-9/]+$/, 'A path is a slash-separated list of child indexes, such as /1/3/2.')
        .describe('Element path from hs_ui_inspect, for example "/1/3/2".'),
      expectLabel: z
        .string()
        .min(1)
        // Generous on purpose: hs_ui_inspect returns labels untruncated, and a
        // cap shorter than what inspect can emit forces the caller into an
        // unverified press on exactly the elements with descriptive labels (#31).
        .max(2000)
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
    })
    // The identity guard is structural, not advisory (#36): a press that
    // checks nothing lands wherever a shifted path happens to point, so a
    // call carrying no expectation fails validation before it reaches the
    // machine. Same pattern as hs_settings' cross-field refine. The Lua
    // program repeats the check for callers that bypass the schema.
    .refine((input) => input.expectLabel !== undefined || input.expectRole !== undefined, {
      message:
        'Pass expectLabel (the label hs_ui_inspect reported for this path) or, for unlabelled elements, expectRole. Without one, a press lands on whatever the path resolves to now, which is not necessarily the element that was inspected.',
    }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(PRESS_LUA, args)),
});
