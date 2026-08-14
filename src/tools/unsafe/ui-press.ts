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
-- Typed check before gmatch: a schema-bypassing caller can hand path any
-- type, and "bad argument #1 to 'gmatch'" diagnoses nothing. The same class
-- of caller can hand a malformed segment, and tonumber's nil must not be
-- silently dropped - '1/x/2' collapsing to /1/2 walks to a wrong element.
if type(ARGS.path) ~= "string" then
  error("path must be a string of child indexes from hs_ui_inspect, such as \\"/1/3/2\\"", 0)
end
-- The schema demands an expectation before any press; repeated here because
-- this program must not trust its caller (#36), and checked before the walk
-- because it depends only on the arguments - a stale path must not mask it.
if ARGS.expectLabel == nil and ARGS.expectRole == nil then
  error("refusing to act: pass expectLabel (the label hs_ui_inspect reported for this path)"
    .. " or, for unlabelled elements, expectRole. Without one, a press lands on whatever the"
    .. " path resolves to now, which is not necessarily the element that was inspected.", 0)
end
local steps = {}
for step in string.gmatch(ARGS.path, "[^/]+") do
  -- 1-based positive integers, written canonically: tonumber alone also
  -- accepts hex, exponent, and whitespace forms ("0x2", "1e2", " 2 "), a
  -- leading zero ("01") aliases a child the text does not literally name,
  -- and "0" would be misdiagnosed as a stale path when the real mistake is
  -- 0-based indexing.
  if not string.match(step, "^[1-9]%d*$") then
    error("path segment '" .. step .. "' is not a child index. Indexes are 1-based; paths look like \\"/1/3/2\\".", 0)
  end
  steps[#steps + 1] = tonumber(step)
end
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
-- The no-expectation refusal itself lives at the top of this program, before
-- the walk, because it depends only on the arguments (#36).
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

local function actionsOf(element)
  local ok, names = pcall(function() return element:actionNames() end)
  if ok and type(names) == "table" and #names > 0 then return names end
  return nil
end

local available = actionsOf(element) or {}
local wanted = ARGS.action or "AXPress"
local supported = false
for _, name in ipairs(available) do
  if name == wanted then supported = true break end
end
if not supported then
  -- An empty action list has two readings and the message must not pick the
  -- wrong one: actionsOf's pcall also swallows the raise of an element that
  -- died since the walk, and "supports: nothing" would steer the caller
  -- toward trying other action names when the honest advice is to re-inspect.
  error("the element at " .. ARGS.path .. " (" .. role .. ") does not support " .. wanted .. ". "
    .. (#available > 0
      and ("It supports: " .. table.concat(available, ", "))
      or "It reports no actions at all - it may also have gone stale since inspection, so re-run hs_ui_inspect."), 0)
end

-- performAction reports failure two ways and both must be checked: a raise
-- (caught by pcall), and a false/nil FIRST RETURN with the reason second.
-- Ignoring the return value reported failed presses as verified successes.
-- The docs are explicit that false/nil only SUGGESTS failure (an action that
-- opened a blocking prompt can time out after delivering), so the message
-- must not claim certainty either way - a categorical "did not happen"
-- invites a destructive double press.
local okPress, outcome, pressErr = pcall(function() return element:performAction(wanted) end)
if not okPress then error("performing " .. wanted .. " failed: " .. tostring(outcome), 0) end
if outcome == false or outcome == nil then
  error("performing " .. wanted .. " did not report success"
    .. (pressErr ~= nil and (": " .. tostring(pressErr)) or "")
    .. ". The press may or may not have been delivered - re-run hs_ui_inspect and check the"
    .. " UI state before retrying, especially for actions that are destructive when repeated.", 0)
end

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
  -- expectRole "?" is the exception that must not claim "role": "?" is what
  -- attr() reports when the role read fails, so "?" == "?" also matches any
  -- dead or unreadable element - a comparison that identifies nothing. The
  -- press is still allowed (a "?"-role element has no stronger expectation
  -- to offer), but verified = false says honestly that nothing was proven.
  verified = (ARGS.expectLabel ~= nil and "label")
    or (ARGS.expectRole ~= nil and ARGS.expectRole ~= "?" and "role")
    or false,
}
`;

export const pressUiTool = defineTool({
  name: 'hs_ui_press',
  tier: 'unsafe',
  title: 'Press a UI element',
  description:
    'Perform an accessibility action on an element found by hs_ui_inspect, usually pressing a button. This acts with the full authority of the user in any application. At least one of expectLabel or expectRole is required: pressing an element frequently reshapes the tree around it, so paths from an earlier inspection can silently point at a different element, and the expectation is what turns that into a refusal instead of a wrong click. Pass expectLabel (the label hs_ui_inspect reported) whenever the element has one; expectRole alone only proves the element is the same kind, not the same element. The result\'s verified field says which check ran: "label" (identity), "role" (kind only - the label field alongside it was read but never compared), or false when the only expectation was the unreadable role "?", which cannot identify an element. Re-run hs_ui_inspect after each press rather than reusing paths from before it.',
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
        // Generous on purpose: hs_ui_inspect returns labels untruncated, and
        // any cap it can exceed forces the caller into weaker role-only
        // verification on exactly the elements with descriptive labels (#31).
        // AXHelp tooltip text runs to paragraphs, so this sits far above
        // anything observed in practice rather than merely above the typical.
        .max(10_000)
        .optional()
        .describe(
          'The label hs_ui_inspect reported for this path. The press is refused if the element there no longer carries it. Omit only for elements that have no label.'
        ),
      expectRole: z
        .string()
        // min(1), not min(2): hs_ui_inspect reports an unreadable role as
        // "?", and an unlabelled element with role "?" must still be
        // pressable with its expectation round-tripped.
        .min(1)
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
