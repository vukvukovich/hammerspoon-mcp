import { z } from 'zod';

import { defineTool, fromBridge } from '../registry.js';
import { lua } from '../../bridge/lua.js';

const LIST_APPS_LUA = lua`
local filter = ARGS.query
if filter then filter = string.lower(filter) end
local out = {}
for _, app in ipairs(hs.application.runningApplications()) do
  local name = app:name()
  if name and ((not filter) or string.find(string.lower(name), filter, 1, true)) then
    out[#out + 1] = {
      name = name,
      pid = app:pid(),
      bundleId = app:bundleID() or "",
      isFrontmost = app:isFrontmost(),
      windowCount = #app:allWindows(),
    }
  end
end
return out
`;

const LAUNCH_APP_LUA = lua`
local ok = hs.application.launchOrFocus(ARGS.name)
if not ok then error("could not launch or focus an app named " .. tostring(ARGS.name), 0) end
return { launched = ARGS.name }
`;

const FOCUS_APP_LUA = lua`
local app = hs.application.find(ARGS.name)
if not app then error("no running app matches " .. tostring(ARGS.name), 0) end
app:activate()
return { name = app:name(), pid = app:pid() }
`;

export const listAppsTool = defineTool({
  name: 'hs_list_apps',
  tier: 'safe',
  title: 'List running applications',
  description:
    'List running applications with pid, bundle identifier, window count, and which one is frontmost.',
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only return applications whose name contains this text, case-insensitive.'),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(LIST_APPS_LUA, args)),
});

export const launchAppTool = defineTool({
  name: 'hs_launch_app',
  tier: 'safe',
  title: 'Launch or focus an application',
  description:
    'Launch an application by name, or focus it if it is already running. Use the name as it appears in Finder, for example "Safari".',
  inputSchema: z.object({
    name: z.string().min(1).max(100).describe('Application name, for example "Safari".'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(LAUNCH_APP_LUA, args)),
});

export const focusAppTool = defineTool({
  name: 'hs_focus_app',
  tier: 'safe',
  title: 'Focus a running application',
  description:
    'Bring an already-running application to the front. Unlike hs_launch_app this never starts anything, so it fails if the application is not running.',
  inputSchema: z.object({
    name: z.string().min(1).max(100).describe('Application name or bundle identifier.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(FOCUS_APP_LUA, args)),
});
