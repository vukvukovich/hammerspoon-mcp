import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * Reading an application's accessibility tree.
 *
 * This is how an agent learns that a window contains a button called "Save"
 * rather than only knowing the window's size. It is the same interface
 * VoiceOver uses, so it works with any well-behaved Mac application.
 *
 * Two deliberate limits.
 *
 * It never returns AXValue, the attribute holding the actual contents of text
 * fields and documents. Structure and labels are what an agent needs to act;
 * contents are what a password manager or a private message is made of, and
 * shipping those to a model by default would make this an exfiltration tool.
 * hs_eval can read them when someone genuinely wants that.
 *
 * The walk is synchronous with hard depth and node budgets. Hammerspoon's own
 * elementSearch is callback-based, which cannot complete inside a single
 * `hs -c` invocation, and an unbounded tree walk on a complex app (a browser
 * with many tabs) can produce tens of thousands of nodes.
 */
const INSPECT_LUA = lua`
local app
if ARGS.app then
  app = hs.application.find(ARGS.app)
  if not app then error("no running application matches '" .. tostring(ARGS.app) .. "'", 0) end
else
  app = hs.application.frontmostApplication()
  if not app then error("no application is frontmost", 0) end
end

local root = hs.axuielement.applicationElement(app)
if not root then
  error("could not read the accessibility tree for " .. (app:name() or "?")
    .. ". Grant Accessibility permission to Hammerspoon in System Settings.", 0)
end

local maxDepth = ARGS.depth or 4
local budget = ARGS.limit or 200
local roleFilter = ARGS.role and string.lower(ARGS.role) or nil
local textFilter = ARGS.contains and string.lower(ARGS.contains) or nil

local visited = 0
local truncated = false

local function attr(element, name)
  local ok, value = pcall(function() return element:attributeValue(name) end)
  if ok and type(value) == "string" then return value end
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

local function actionsOf(element)
  local ok, names = pcall(function() return element:actionNames() end)
  if ok and type(names) == "table" and #names > 0 then return names end
  return nil
end

local function walk(element, depth, path)
  if visited >= budget then truncated = true return nil end
  visited = visited + 1

  local role = attr(element, "AXRole") or "?"
  local label = labelOf(element)

  local node = {
    path = path,
    role = role,
    label = label,
    actions = actionsOf(element),
  }

  local okEnabled, enabled = pcall(function() return element:attributeValue("AXEnabled") end)
  if okEnabled and type(enabled) == "boolean" then node.enabled = enabled end

  local kids
  if depth < maxDepth then
    local ok, children = pcall(function() return element:attributeValue("AXChildren") end)
    if ok and type(children) == "table" then
      kids = {}
      for index, child in ipairs(children) do
        local sub = walk(child, depth + 1, path .. "/" .. tostring(index))
        if sub then kids[#kids + 1] = sub end
      end
      if #kids == 0 then kids = nil end
    end
  end
  node.children = kids

  -- Filters prune the OUTPUT, not the walk: a matching button is usually deep
  -- inside non-matching containers, so the traversal has to continue anyway.
  if roleFilter or textFilter then
    local matches = true
    if roleFilter and string.lower(role) ~= roleFilter
      and not string.find(string.lower(role), roleFilter, 1, true) then
      matches = false
    end
    if matches and textFilter then
      matches = label ~= nil and string.find(string.lower(label), textFilter, 1, true) ~= nil
    end
    if not matches and kids == nil then return nil end
    if not matches then
      -- Keep descendants that matched, drop this node's own detail.
      return { path = path, role = role, children = kids }
    end
  end

  return node
end

local tree = walk(root, 0, "")

return {
  app = app:name() or "",
  bundleId = app:bundleID() or "",
  truncated = truncated,
  nodesVisited = visited,
  tree = tree,
}
`;

export const inspectUiTool = defineTool({
  name: 'hs_ui_inspect',
  tier: 'safe',
  title: 'Inspect an application UI',
  description:
    "Read an application's accessibility tree: the buttons, menus, fields, and their labels, with the actions each supports. This is how you find out what is clickable in an app and what it is called. Returns structure and labels only, never the contents of text fields or documents. Each node carries a path you can pass to hs_ui_press.",
  inputSchema: z.object({
    app: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Application name. Defaults to the frontmost application.'),
    role: z
      .string()
      .min(2)
      .max(40)
      .optional()
      .describe('Only report elements whose role matches, for example "AXButton" or "button".'),
    contains: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('Only report elements whose label contains this text, case-insensitive.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(4)
      .describe('How deep to descend. Deeper finds more but returns much more.'),
    limit: z
      .number()
      .int()
      .min(10)
      .max(2000)
      .default(200)
      .describe('Maximum nodes to visit before stopping and reporting truncated.'),
  }),
  annotations: { readOnlyHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(INSPECT_LUA, args)),
});
