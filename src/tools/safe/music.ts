import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge, jsonResult } from '../registry.js';

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

-- The modules return raw AppleScript four-character codes (kPSP, kPSp, kPSS);
-- their own state_* constants are the decoder ring (#18).
local function readableState(module, state)
  if state == module.state_playing then return "playing" end
  if state == module.state_paused then return "paused" end
  if state == module.state_stopped then return "stopped" end
  return "unknown"
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
      state = readableState(module, state),
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

-- Captured before acting so the handler can tell "still reporting the old
-- track" from "the skip landed on this track" (#24).
local before = nil
pcall(function() before = module.getCurrentTrack() end)

local action = ARGS.action
if action == "play" then module.play()
elseif action == "pause" then module.pause()
elseif action == "playpause" then module.playpause()
elseif action == "next" then module.next()
elseif action == "previous" then module.previous()
else error("unknown action " .. tostring(action), 0) end

-- No state here: the player updates what it reports a moment after the
-- command, so a read now claims the pre-action state ("play" answered
-- "paused", #18). The handler waits and asks again.
return { player = ARGS.player, action = action, before = before }
`;

const MUSIC_READ_SCHEMA = z.looseObject({
  state: z.string().optional(),
  isPlaying: z.boolean().optional(),
  track: z.string().nullish(),
});

const MUSIC_ACT_SCHEMA = z.looseObject({
  before: z.string().nullish(),
});

/** How long the player gets to catch its reported state up with the command
 * it just executed. Measured: Spotify still answered the old state when asked
 * immediately, and was correct by the next separate call. */
const MUSIC_SETTLE_MS = 250;

/** A track skip can take longer than a state flip: the player still reports
 * the pre-skip song during a slow transition, so next/previous poll for the
 * track to change instead of trusting one settle (#24). */
const TRACK_CHANGE_BUDGET_MS = 1500;

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
    'Play, pause, or skip in Spotify or the Music app specifically. Use this instead of hs_media_control when more than one player could respond to a media key. The reported state is read back after the action settles, so it reflects what the player is now doing. Errors rather than launching the app if it is not already running.',
  inputSchema: z.object({
    player: z.enum(['spotify', 'music']).describe('Which player to control.'),
    action: z.enum(['play', 'pause', 'playpause', 'next', 'previous']).describe('What to do.'),
  }),
  handler: async (args, { bridge }) => {
    const acted = await bridge.run(MUSIC_CONTROL_LUA, args);
    if (!acted.ok) return fromBridge(acted);
    const before = MUSIC_ACT_SCHEMA.safeParse(acted.value);
    const previousTrack = before.success ? before.data.before : undefined;

    const isSkip = args.action === 'next' || args.action === 'previous';
    const deadline = Date.now() + (isSkip ? TRACK_CHANGE_BUDGET_MS : MUSIC_SETTLE_MS);

    let observed: z.infer<typeof MUSIC_READ_SCHEMA> | undefined;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, MUSIC_SETTLE_MS));
      const status = await bridge.run(MUSIC_STATUS_LUA, { player: args.player });
      if (status.ok) {
        const parsed = MUSIC_READ_SCHEMA.safeParse(status.value);
        if (parsed.success) {
          observed = parsed.data;
          // For skips, keep polling until the reported track moves off the
          // pre-action one; other actions need only the one settled read.
          const trackMoved =
            previousTrack === undefined ||
            previousTrack === null ||
            (observed.track !== undefined && observed.track !== previousTrack);
          if (!isSkip || trackMoved) break;
        }
      }
      if (Date.now() >= deadline) break;
    }

    if (observed === undefined) return fromBridge(acted);
    return jsonResult({
      player: args.player,
      action: args.action,
      ...(observed.state === undefined ? {} : { state: observed.state }),
      ...(observed.isPlaying === undefined ? {} : { isPlaying: observed.isPlaying }),
      ...(observed.track === undefined || observed.track === null ? {} : { track: observed.track }),
    });
  },
});
