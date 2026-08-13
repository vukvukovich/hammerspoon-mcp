import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

const STATUS_LUA = lua`
-- Each reading is wrapped: these APIs return nil on hardware that lacks the
-- feature (a desktop Mac has no battery, an ethernet-only Mac no wifi), and
-- one nil should not cost the caller the whole report.
local function safe(fn)
  local ok, value = pcall(fn)
  if ok then return value end
  return nil
end

return {
  host = {
    name = safe(function() return hs.host.localizedName() end),
    os = safe(function() return hs.host.operatingSystemVersionString() end),
    idleSeconds = safe(function() return math.floor(hs.host.idleTime()) end),
  },
  battery = {
    percentage = safe(function() return hs.battery.percentage() end),
    powerSource = safe(function() return hs.battery.powerSource() end),
    isCharging = safe(function() return hs.battery.isCharging() end),
    minutesRemaining = safe(function()
      local t = hs.battery.timeRemaining()
      -- -1 means calculating, -2 means unlimited (on AC). Neither is a duration.
      if type(t) == "number" and t >= 0 then return t end
      return nil
    end),
  },
  display = {
    brightness = safe(function() return hs.brightness.get() end),
    screens = safe(function() return #hs.screen.allScreens() end),
  },
  -- wifiPower is always present, so this encodes as an object even when no
  -- network is joined; a table holding only nils encoded as a bare [] (#18).
  network = {
    wifiPower = safe(function() return hs.wifi.interfaceDetails().power end) == true,
    wifiSsid = safe(function() return hs.wifi.currentNetwork() end),
  },
  audio = {
    outputDevice = safe(function() return hs.audiodevice.defaultOutputDevice():name() end),
    volume = safe(function() return hs.audiodevice.defaultOutputDevice():volume() end),
    muted = safe(function() return hs.audiodevice.defaultOutputDevice():muted() end),
  },
}
`;

const BRIGHTNESS_LUA = lua`
if ARGS.level ~= nil then
  local ok = hs.brightness.set(math.floor(ARGS.level))
  if not ok then
    error("could not set brightness. External displays often do not support this.", 0)
  end
end
return { brightness = hs.brightness.get() }
`;

/**
 * Media keys are system-wide transport controls, not keystrokes delivered to a
 * focused application. They cannot be used to type into a terminal, which is
 * why they are acceptable in the safe tier while general input synthesis is
 * excluded at every tier.
 */
const MEDIA_LUA = lua`
local key = ({
  playpause = "PLAY",
  next = "NEXT",
  previous = "PREVIOUS",
  fast = "FAST",
  rewind = "REWIND",
})[ARGS.action]
if not key then error("unknown media action " .. tostring(ARGS.action), 0) end

hs.eventtap.event.newSystemKeyEvent(key, true):post()
hs.eventtap.event.newSystemKeyEvent(key, false):post()

return { action = ARGS.action, sent = key }
`;

export const machineStatusTool = defineTool({
  name: 'hs_machine_status',
  tier: 'safe',
  title: 'Report machine status',
  description:
    'One call for the state of the machine: host name and OS version, idle time, battery level and charging state, display brightness and screen count, current wifi network, and default audio device with its volume. Fields are null where the hardware does not provide them.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(STATUS_LUA)),
});

export const brightnessTool = defineTool({
  name: 'hs_brightness',
  tier: 'safe',
  title: 'Get or set display brightness',
  description:
    'Read or change the built-in display brightness, 0 to 100. Called with no arguments it only reports. Most external displays do not support software brightness control and will report an error.',
  inputSchema: z.object({
    level: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Brightness percentage. Omit to read the current value.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(BRIGHTNESS_LUA, args)),
});

export const mediaControlTool = defineTool({
  name: 'hs_media_control',
  tier: 'safe',
  title: 'Control media playback',
  description:
    'Send a system media key: play or pause, next track, previous track. Works with whichever application currently owns media playback (Music, Spotify, a browser tab), the same as pressing the key on the keyboard.',
  inputSchema: z.object({
    action: z
      .enum(['playpause', 'next', 'previous', 'fast', 'rewind'])
      .describe('Which transport control to send.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(MEDIA_LUA, args)),
});
