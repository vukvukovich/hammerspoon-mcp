import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * The tail of small, self-contained capabilities: speech, network reachability,
 * caps lock, and durable key-value storage.
 */

/**
 * A speaker garbage-collected mid-sentence stops speaking, and the chunk ends
 * the instant speak() returns. Parking it in one module-level global keeps the
 * current utterance alive. Only one is ever held, so this does not grow, and it
 * is not a handle registry: nothing is addressable and nothing needs releasing.
 */
const SPEAK_LUA = lua`
local voiceName = nil
if ARGS.voice then
  -- hs.speech.new documents nil for an unknown voice, but on macOS 26 it
  -- happily returns a synthesiser using the default voice instead, so a typo
  -- silently spoke in the wrong voice while echoing the bogus name (#17).
  -- Validation has to happen against the list, not the constructor. Both the
  -- short names and the full identifiers from hs_list_voices are accepted.
  local wanted = string.lower(ARGS.voice)
  local matches = {}
  local short = hs.speech.availableVoices() or {}
  local full = hs.speech.availableVoices(true) or {}
  for index, name in ipairs(short) do
    local id = full[index] or name
    if string.lower(name) == wanted or string.lower(id) == wanted then
      voiceName = id
      break
    end
    if string.find(string.lower(name), wanted, 1, true) then matches[#matches + 1] = name end
  end
  -- A single substring match is unambiguous, so use it: modern voices only
  -- exist under full identifiers ("Daniel" is com.apple.voice.compact.en-GB
  -- .Daniel), and refusing the obvious one would punish every reasonable
  -- caller. Several matches stay an error, because picking one silently is
  -- exactly the bug this fixes.
  if not voiceName and #matches == 1 then voiceName = matches[1] end
  if not voiceName then
    local hint = #matches > 0
      and (" Did you mean one of: " .. table.concat(matches, ", ") .. "?") or ""
    error("no voice named '" .. tostring(ARGS.voice) .. "'." .. hint
      .. " Call hs_list_voices for the full list.", 0)
  end
end

if _hsmcp_speaker and _hsmcp_speaker:isSpeaking() then
  _hsmcp_speaker:stop()
end

if voiceName then
  _hsmcp_speaker = hs.speech.new(voiceName)
else
  _hsmcp_speaker = hs.speech.new()
end
if not _hsmcp_speaker then
  error("could not create a speech synthesiser", 0)
end

if ARGS.rate then _hsmcp_speaker:rate(ARGS.rate) end
local started = _hsmcp_speaker:speak(ARGS.text)
if not started then error("the synthesiser refused to speak that text", 0) end

-- Read the voice back from the synthesiser rather than echoing the request.
-- The modern system voice is not in the legacy voice list and reads back
-- empty, so name that case explicitly instead of returning "".
local inUse = _hsmcp_speaker:voice()
if inUse == nil or inUse == "" then inUse = voiceName or "system default" end

return { speaking = true, voice = inUse, characters = #ARGS.text }
`;

const VOICES_LUA = lua`
local voices = hs.speech.availableVoices() or {}
local names = {}
for _, voice in ipairs(voices) do
  -- Entries are full identifiers such as com.apple.voice.compact.en-GB.Daniel.
  -- The trailing component is the name a person would say.
  names[#names + 1] = string.match(voice, "([^%.]+)$") or voice
end
table.sort(names)
return { count = #names, voices = names }
`;

const NETWORK_LUA = lua`
local function safe(fn, fallback)
  local ok, value = pcall(fn)
  if ok and value ~= nil then return value end
  return fallback
end

local primary = safe(function() return hs.network.primaryInterfaces() end, nil)
local interfaceName = type(primary) == "string" and primary or nil

local result = {
  primaryInterface = interfaceName,
  wifiSsid = safe(function() return hs.wifi.currentNetwork() end, nil),
}

if interfaceName then
  local details = safe(function() return hs.network.interfaceDetails(interfaceName) end, {})
  local ipv4 = details and details.IPv4
  if ipv4 and ipv4.Addresses then result.addresses = ipv4.Addresses end
  if ipv4 and ipv4.Router then result.router = ipv4.Router end
end

if ARGS.host then
  -- Reachability is synchronous, unlike hs.network.ping which is callback
  -- based and could never complete inside one hs invocation.
  local watcher = safe(function() return hs.network.reachability.forHostName(ARGS.host) end, nil)
  if watcher then
    local flags = watcher:status()
    result.host = {
      name = ARGS.host,
      reachable = (flags & hs.network.reachability.flags.reachable) ~= 0,
      requiresConnection = (flags & hs.network.reachability.flags.connectionRequired) ~= 0,
      flags = flags,
    }
  end
end

return result
`;

const CAPSLOCK_LUA = lua`
if ARGS.enabled ~= nil then hs.hid.capslock.set(ARGS.enabled) end
return { capsLock = hs.hid.capslock.get() }
`;

/**
 * Persistent storage is namespaced under a fixed prefix.
 *
 * hs.settings is the same store the user's own configuration uses. Writing an
 * unprefixed key could silently clobber something their config depends on, and
 * listing keys unprefixed would expose it. Every key here is forced under
 * "hsmcp." so this tool cannot reach anything it did not write.
 */
const SETTINGS_LUA = lua`
local PREFIX = "hsmcp."

if ARGS.action == "list" then
  local out = {}
  for _, key in ipairs(hs.settings.getKeys() or {}) do
    if string.sub(key, 1, #PREFIX) == PREFIX then
      out[#out + 1] = { key = string.sub(key, #PREFIX + 1), value = hs.settings.get(key) }
    end
  end
  table.sort(out, function(a, b) return a.key < b.key end)
  return { count = #out, settings = out }
end

if not ARGS.key then error("key is required for get, set, and delete", 0) end
local full = PREFIX .. ARGS.key

if ARGS.action == "get" then
  return { key = ARGS.key, value = hs.settings.get(full) }
end

if ARGS.action == "set" then
  if ARGS.value == nil then error("value is required when setting", 0) end
  hs.settings.set(full, ARGS.value)
  return { key = ARGS.key, value = hs.settings.get(full), stored = true }
end

if ARGS.action == "delete" then
  hs.settings.clear(full)
  return { key = ARGS.key, deleted = true }
end

error("unknown action " .. tostring(ARGS.action), 0)
`;

export const speakTool = defineTool({
  name: 'hs_speak',
  tier: 'safe',
  title: 'Speak text aloud',
  description:
    'Say something out loud through the Mac speech synthesiser. Returns as soon as speech starts rather than waiting for it to finish. Calling again interrupts whatever is currently being spoken.',
  inputSchema: z.object({
    text: z.string().min(1).max(2000).describe('What to say.'),
    voice: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe('Voice name from hs_list_voices. Omit for the system default.'),
    rate: z
      .number()
      .min(50)
      .max(500)
      .optional()
      .describe('Words per minute. The default is around 175.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(SPEAK_LUA, args)),
});

export const listVoicesTool = defineTool({
  name: 'hs_list_voices',
  tier: 'safe',
  title: 'List speech voices',
  description: 'List the installed speech synthesiser voices usable with hs_speak.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(VOICES_LUA)),
});

export const networkTool = defineTool({
  name: 'hs_network',
  tier: 'safe',
  title: 'Report network state',
  description:
    'Report the primary network interface, its IP addresses and router, the current wifi network, and optionally whether a given host is reachable. Reachability is a routing check, not a ping, so it answers instantly and does not prove the host is up.',
  inputSchema: z.object({
    host: z
      .string()
      .min(1)
      .max(253)
      .optional()
      .describe('Hostname to check reachability for, for example github.com.'),
  }),
  annotations: { readOnlyHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(NETWORK_LUA, args)),
});

export const capsLockTool = defineTool({
  name: 'hs_caps_lock',
  tier: 'safe',
  title: 'Get or set caps lock',
  description:
    'Read or change the caps lock state, including its keyboard light. Called with no arguments it only reports.',
  inputSchema: z.object({
    enabled: z.boolean().optional().describe('Turn caps lock on or off. Omit to only report.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(CAPSLOCK_LUA, args)),
});

export const settingsTool = defineTool({
  name: 'hs_settings',
  tier: 'safe',
  title: 'Durable key-value storage',
  description:
    "Store small values that survive Hammerspoon restarts, for remembering things between sessions. Keys are namespaced so this can never read or overwrite the user's own Hammerspoon settings. Values must be JSON-compatible.",
  inputSchema: z
    .object({
      action: z.enum(['get', 'set', 'delete', 'list']).describe('What to do.'),
      key: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Key name. Required for get, set, and delete.'),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe('Value to store. Required when setting.'),
    })
    .refine((input) => input.action === 'list' || input.key !== undefined, {
      message: 'key is required unless the action is list.',
    }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(SETTINGS_LUA, args)),
});
