import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * Read-only inventory of what is attached to the machine, plus notifications.
 *
 * These are the questions an agent cannot answer from a shell without knowing
 * obscure system commands, and getting them wrong is expensive: "is the
 * external drive mounted", "which camera is in use", "what networks can I see".
 */

const PERIPHERALS_LUA = lua`
local function safe(fn, fallback)
  local ok, value = pcall(fn)
  if ok and value ~= nil then return value end
  return fallback
end

local usb = {}
for _, device in ipairs(safe(function() return hs.usb.attachedDevices() end, {})) do
  usb[#usb + 1] = {
    name = device.productName or "",
    vendor = device.vendorName or "",
    productId = device.productID,
    vendorId = device.vendorID,
  }
end

local cameras = {}
for _, camera in ipairs(safe(function() return hs.camera.allCameras() end, {})) do
  cameras[#cameras + 1] = {
    name = safe(function() return camera:name() end, ""),
    inUse = safe(function() return camera:isInUse() end, false),
  }
end

local volumes = {}
for path, info in pairs(safe(function() return hs.fs.volume.allVolumes() end, {})) do
  volumes[#volumes + 1] = {
    path = path,
    name = info.NSURLVolumeNameKey or "",
    removable = info.NSURLVolumeIsRemovableKey or false,
    -- Reported in bytes; gigabytes is what a person can act on.
    freeGb = info.NSURLVolumeAvailableCapacityKey
      and math.floor(info.NSURLVolumeAvailableCapacityKey / 1073741824 * 10) / 10 or nil,
  }
end

return { usb = usb, cameras = cameras, volumes = volumes }
`;

const WIFI_SCAN_LUA = lua`
local current = hs.wifi.currentNetwork()
local networks = {}

-- availableNetworks does a live scan and can be slow or blocked by privacy
-- settings, so a failure here should still return the current network.
local ok, scanned = pcall(function() return hs.wifi.availableNetworks() end)
if ok and scanned then
  for _, ssid in ipairs(scanned) do networks[#networks + 1] = ssid end
  table.sort(networks)
end

return {
  current = current,
  scanned = ok,
  available = networks,
}
`;

const NOTIFY_LUA = lua`
local notification = hs.notify.new({
  title = ARGS.title,
  informativeText = ARGS.text,
  withdrawAfter = ARGS.withdrawAfter or 0,
})
if not notification then error("could not create the notification", 0) end
notification:send()
return { sent = true, title = ARGS.title }
`;

export const peripheralsTool = defineTool({
  name: 'hs_peripherals',
  tier: 'safe',
  title: 'List attached hardware',
  description:
    'List USB devices, cameras (including whether one is currently in use), and mounted volumes with free space. Answers questions like whether an external drive is mounted or whether the webcam is active.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(PERIPHERALS_LUA)),
});

export const wifiTool = defineTool({
  name: 'hs_wifi',
  tier: 'safe',
  title: 'Show wifi networks',
  description:
    'Report the current wifi network and scan for available ones. Scanning can be slow or blocked by privacy settings, in which case the current network is still reported and `scanned` is false.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(WIFI_SCAN_LUA)),
});

export const notifyCenterTool = defineTool({
  name: 'hs_notification',
  tier: 'safe',
  title: 'Post a notification',
  description:
    'Post a real macOS notification, which persists in Notification Center. Use this when the user should see something after stepping away. For a transient on-screen message that leaves no trace, use hs_notify instead.',
  inputSchema: z.object({
    title: z.string().min(1).max(120).describe('Notification title.'),
    text: z.string().max(500).default('').describe('Body text.'),
    withdrawAfter: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(0)
      .describe('Seconds before it withdraws itself. 0 keeps it in Notification Center.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(NOTIFY_LUA, args)),
});
