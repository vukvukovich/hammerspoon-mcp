import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

const OPEN_URL_LUA = lua`
local url = ARGS.url

if ARGS.bundleId then
  local ok = hs.urlevent.openURLWithBundle(url, ARGS.bundleId)
  if not ok then
    error("could not open the URL with bundle id '" .. tostring(ARGS.bundleId)
      .. "'. Check it is installed and the id is right.", 0)
  end
  return { url = url, openedWith = ARGS.bundleId }
end

hs.urlevent.openURL(url)
return { url = url, openedWith = "default handler" }
`;

const DEFAULT_BROWSER_LUA = lua`
if ARGS.bundleId then
  hs.urlevent.setDefaultHandler("http", ARGS.bundleId)
end
return {
  http = hs.urlevent.getDefaultHandler("http"),
  https = hs.urlevent.getDefaultHandler("https"),
  mailto = hs.urlevent.getDefaultHandler("mailto"),
}
`;

export const openUrlTool = defineTool({
  name: 'hs_open_url',
  tier: 'safe',
  title: 'Open a URL',
  description:
    'Open a URL in the default browser, or in a specific application by bundle id (for example com.google.Chrome or com.apple.Safari). Use hs_list_apps to find bundle ids.',
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .max(2000)
      .describe('The URL to open. Include the scheme, for example https://.'),
    bundleId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Bundle id of the app to open it with. Omit to use the default handler.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(OPEN_URL_LUA, args)),
});

export const defaultBrowserTool = defineTool({
  name: 'hs_default_browser',
  tier: 'safe',
  title: 'Get or set the default browser',
  description:
    'Report which application handles http, https, and mailto links, and optionally change the http and https handler. Called with no arguments it only reports. Changing it may make macOS ask the user to confirm.',
  inputSchema: z.object({
    bundleId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Bundle id to become the default browser. Omit to only report.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(DEFAULT_BROWSER_LUA, args)),
});
