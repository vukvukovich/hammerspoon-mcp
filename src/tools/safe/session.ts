import { z } from 'zod';

import { lua } from '../../bridge/lua.js';
import { defineTool, fromBridge } from '../registry.js';

/**
 * Session and power state: locking, sleep prevention, and the screen.
 *
 * Sleeping and restarting the machine are deliberately NOT here. They discard
 * unsaved work, and an agent acting on a misread instruction should not be able
 * to do that. Locking is the safe half of the same idea: it protects the
 * machine and costs nothing if it was a mistake.
 */

const CAFFEINATE_STATUS_LUA = lua`
return {
  displayIdle = hs.caffeinate.get("displayIdle") or false,
  systemIdle = hs.caffeinate.get("systemIdle") or false,
  system = hs.caffeinate.get("system") or false,
}
`;

const CAFFEINATE_SET_LUA = lua`
-- displayIdle keeps the screen awake, which is what people mean by "keep the
-- machine awake". systemIdle alone still lets the display sleep.
hs.caffeinate.set("displayIdle", ARGS.awake, true)
return {
  awake = ARGS.awake,
  displayIdle = hs.caffeinate.get("displayIdle") or false,
}
`;

const LOCK_SCREEN_LUA = lua`
hs.caffeinate.lockScreen()
return { locked = true }
`;

export const caffeinateTool = defineTool({
  name: 'hs_keep_awake',
  tier: 'safe',
  title: 'Prevent or allow sleep',
  description:
    'Stop the Mac from sleeping, or let it sleep again. Called with no arguments it reports the current state. Useful before a long build or download.',
  inputSchema: z.object({
    awake: z
      .boolean()
      .optional()
      .describe('True to prevent sleep, false to allow it. Omit to only report the state.'),
  }),
  handler: async (args, { bridge }) =>
    args.awake === undefined
      ? fromBridge(await bridge.run(CAFFEINATE_STATUS_LUA))
      : fromBridge(await bridge.run(CAFFEINATE_SET_LUA, args)),
});

export const lockScreenTool = defineTool({
  name: 'hs_lock_screen',
  tier: 'safe',
  title: 'Lock the screen',
  description:
    'Lock the Mac immediately, as if you pressed the lock shortcut. Applications keep running and nothing is closed, so this is safe to do at any time.',
  inputSchema: z.object({}),
  handler: async (_args, { bridge }) => fromBridge(await bridge.run(LOCK_SCREEN_LUA)),
});
