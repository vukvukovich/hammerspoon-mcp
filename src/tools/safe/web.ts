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

-- Not hs.urlevent.openURL: that helper ignores an unknown scheme's missing
-- handler and dies inside the native layer with "incorrect type 'nil' for
-- argument 2". Resolving the handler here gives a real error for a scheme
-- nothing handles, and lets the result name the application actually used
-- instead of the phrase "default handler" (#17).
local scheme = string.match(url, "^(%a[%w+.-]*)://")
if not scheme then
  error("the URL must include a scheme followed by '://', like https://example.com", 0)
end
local handler = hs.urlevent.getDefaultHandler(scheme)
if not handler or handler == "" then
  error("nothing on this Mac handles '" .. scheme .. "://' URLs", 0)
end
local ok = hs.urlevent.openURLWithBundle(url, handler)
if not ok then
  error("macOS refused to open '" .. tostring(url) .. "' with " .. handler, 0)
end
return { url = url, openedWith = handler }
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
    'Open a URL in the default handler for its scheme, or in a specific application by bundle id (for example com.google.Chrome or com.apple.Safari). The result names the application that actually received the URL. Errors when nothing handles the scheme or macOS refuses. Use hs_list_apps to find bundle ids.',
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .max(2000)
      // hs.urlevent.openURL documents that the URL "must contain a scheme and
      // '://'"; anything else used to be accepted and silently did nothing.
      .regex(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/, {
        message: "Must be a URL with a scheme, like https://example.com. Spaces aren't allowed.",
      })
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
