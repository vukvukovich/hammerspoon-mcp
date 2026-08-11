import { z } from 'zod';

import { defineTool, fromBridge } from '../registry.js';
import { lua } from '../../bridge/lua.js';

/**
 * Static Lua. Never interpolate into this string: see src/bridge/codec.ts for
 * why arguments travel through ARGS instead.
 */
const HEALTH_LUA = lua`
return {
  hammerspoonVersion = hs.processInfo.version,
  screenCount = #hs.screen.allScreens(),
  ipc = true,
}
`;

export const healthTool = defineTool({
  name: 'hs_health',
  tier: 'safe',
  title: 'Check Hammerspoon connection',
  description:
    'Verify that Hammerspoon is running and reachable, and report its version. Call this first when any other tool fails, because it distinguishes a setup problem from a tool problem.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, { bridge }) => {
    const result = await bridge.run(HEALTH_LUA);
    return fromBridge(result, (value) => jsonWithPath(value, bridge.hsPath));
  },
});

function jsonWithPath(value: unknown, hsPath: string | undefined): ReturnType<typeof fromBridge> {
  const payload = {
    ...(typeof value === 'object' && value !== null ? value : { value }),
    hsPath: hsPath ?? 'not found',
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
