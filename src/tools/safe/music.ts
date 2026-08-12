import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * Player-specific music control.
 *
 * hs_media_control already sends system media keys, which work with whatever
 * owns playback. These tools are the other half: they name a player, so they
 * can report what is actually playing and target one app when several could
 * respond to a media key.
 *
 * Both players are addressed through the same shape because hs.spotify and
 * hs.itunes expose identical function names. hs.itunes drives the Music app
 * on modern macOS despite the module name.
 */

const MUSIC_STATUS_LUA = lua`
-- Asking a player anything launches it if it is not running, which is a
-- surprising side effect for a status call. Check first.
local function playerFor(name)
  local module = name == "spotify" and hs.spotify or hs.itunes
  local appName = name == "spotify" and "Spotify" or "Music"
  local running = hs.application.get(appName) ~= nil
  return module, appName, running
end

local function describe(name)
  local module, appName, running = playerFor(name)
  if not running then
    return { player = name, app = appName, running = false }
  end

  local ok, info = pcall(function()
    local state = module.getPlaybackState()
    return {
      player = name,
      app = appName,
      running = true,
      state = state,
      isPlaying = state == module.state_playing,
      track = module.getCurrentTrack(),
      artist = module.getCurrentArtist(),
      album = module.getCurrentAlbum(),
      position = module.getPosition(),
      duration = module.getDuration(),
    }
  end)
  if ok then return info end
  return { player = name, app = appName, running = true, error = tostring(info) }
end

local wanted = ARGS.player
if wanted then return describe(wanted) end
return { spotify = describe("spotify"), music = describe("music") }
`;

const MUSIC_CONTROL_LUA = lua`
local module = ARGS.player == "spotify" and hs.spotify or hs.itunes
local appName = ARGS.player == "spotify" and "Spotify" or "Music"

if not hs.application.get(appName) then
  error(appName .. " is not running. Launch it first with hs_launch_app if you want to start it.", 0)
end

local action = ARGS.action
if action == "play" then module.play()
elseif action == "pause" then module.pause()
elseif action == "playpause" then module.playpause()
elseif action == "next" then module.next()
elseif action == "previous" then module.previous()
else error("unknown action " .. tostring(action), 0) end

return {
  player = ARGS.player,
  action = action,
  state = module.getPlaybackState(),
  track = module.getCurrentTrack(),
}
`;

export const musicStatusTool = defineTool({
  name: 'hs_music_status',
  tier: 'safe',
  title: 'What is playing',
  description:
    'Report the current track, artist, album, position, and playback state for Spotify and the Music app. A player that is not running is reported as such rather than being launched, so this is safe to call as a plain query.',
  inputSchema: z.object({
    player: z
      .enum(['spotify', 'music'])
      .optional()
      .describe('Ask one player only. Omit to report both.'),
  }),
  annotations: { readOnlyHint: true },
  handler: async (args, { bridge }) => fromBridge(await bridge.run(MUSIC_STATUS_LUA, args)),
});

export const musicControlTool = defineTool({
  name: 'hs_music_control',
  tier: 'safe',
  title: 'Control a specific music player',
  description:
    'Play, pause, or skip in Spotify or the Music app specifically. Use this instead of hs_media_control when more than one player could respond to a media key. Errors rather than launching the app if it is not already running.',
  inputSchema: z.object({
    player: z.enum(['spotify', 'music']).describe('Which player to control.'),
    action: z.enum(['play', 'pause', 'playpause', 'next', 'previous']).describe('What to do.'),
  }),
  handler: async (args, { bridge }) => fromBridge(await bridge.run(MUSIC_CONTROL_LUA, args)),
});
