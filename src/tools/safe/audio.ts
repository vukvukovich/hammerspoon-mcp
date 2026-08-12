import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

const LIST_DEVICES_LUA = lua`
local function describe(device, isDefault)
  return {
    name = device:name() or "",
    uid = device:uid() or "",
    isDefault = isDefault,
    muted = device:muted() or false,
    volume = device:volume(),
    transport = device:transportType() or "",
  }
end

local out = { output = {}, input = {} }

local defaultOut = hs.audiodevice.defaultOutputDevice()
local defaultOutUid = defaultOut and defaultOut:uid() or ""
for _, d in ipairs(hs.audiodevice.allOutputDevices()) do
  out.output[#out.output + 1] = describe(d, d:uid() == defaultOutUid)
end

local defaultIn = hs.audiodevice.defaultInputDevice()
local defaultInUid = defaultIn and defaultIn:uid() or ""
for _, d in ipairs(hs.audiodevice.allInputDevices()) do
  out.input[#out.input + 1] = describe(d, d:uid() == defaultInUid)
end

return out
`;

const SET_DEVICE_LUA = lua`
local wanted = string.lower(ARGS.name)
local devices = ARGS.direction == "input" and hs.audiodevice.allInputDevices()
  or hs.audiodevice.allOutputDevices()

local match
for _, d in ipairs(devices) do
  local name = d:name() or ""
  if string.lower(name) == wanted then
    match = d
    break
  end
  if not match and string.find(string.lower(name), wanted, 1, true) then
    match = d
  end
end

if not match then
  local available = {}
  for _, d in ipairs(devices) do available[#available + 1] = d:name() or "?" end
  error("no " .. ARGS.direction .. " device matches '" .. tostring(ARGS.name)
    .. "'. Available: " .. table.concat(available, ", "), 0)
end

local ok
if ARGS.direction == "input" then
  ok = match:setDefaultInputDevice()
else
  ok = match:setDefaultOutputDevice()
end
if not ok then error("the system refused to switch to " .. (match:name() or "?"), 0) end

return { direction = ARGS.direction, name = match:name(), uid = match:uid() }
`;

const VOLUME_LUA = lua`
local device = ARGS.direction == "input" and hs.audiodevice.defaultInputDevice()
  or hs.audiodevice.defaultOutputDevice()
if not device then error("no default " .. ARGS.direction .. " device", 0) end

if ARGS.volume ~= nil then device:setVolume(ARGS.volume) end
if ARGS.muted ~= nil then device:setMuted(ARGS.muted) end

return {
  name = device:name() or "",
  direction = ARGS.direction,
  volume = device:volume(),
  muted = device:muted() or false,
}
`;

export const audioDevicesTool = defineTool({
  name: 'hs_audio_devices',
  tier: 'safe',
  title: 'List audio devices',
  description:
    'List audio output and input devices, showing which is currently the default plus its volume and mute state. Call this before hs_audio_set_device to learn the exact device names.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(LIST_DEVICES_LUA)),
});

export const audioSetDeviceTool = defineTool({
  name: 'hs_audio_set_device',
  tier: 'safe',
  title: 'Switch the default audio device',
  description:
    'Make an audio device the system default, for example switching output to headphones or a display. Matches the name exactly first, then falls back to a case-insensitive substring, and lists the available devices when nothing matches.',
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('Device name from hs_audio_devices. A substring is accepted.'),
    direction: z
      .enum(['output', 'input'])
      .default('output')
      .describe(
        'Which default to change. Output is speakers and headphones, input is microphones.'
      ),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(SET_DEVICE_LUA, args)),
});

export const audioVolumeTool = defineTool({
  name: 'hs_audio_volume',
  tier: 'safe',
  title: 'Get or set volume and mute',
  description:
    'Read or change the volume and mute state of the default audio device. Called with no arguments it only reports the current state, so it is safe to use as a query.',
  inputSchema: z.object({
    volume: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Volume percentage. Omit to leave it unchanged.'),
    muted: z.boolean().optional().describe('Mute state. Omit to leave it unchanged.'),
    direction: z.enum(['output', 'input']).default('output'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(VOLUME_LUA, args)),
});
