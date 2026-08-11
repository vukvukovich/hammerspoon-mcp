import { apiSearchTool } from './safe/api-search.js';
import { windowLayoutTool } from './safe/layout.js';
import { focusAppTool, launchAppTool, listAppsTool } from './safe/apps.js';
import { healthTool } from './safe/health.js';
import { consoleTailTool, notifyTool, reloadConfigTool, screensTool } from './safe/system.js';
import { focusWindowTool, listWindowsTool, moveWindowTool } from './safe/windows.js';
import { evalTool } from './unsafe/eval.js';
import type { RegisterableTool } from './registry.js';

/**
 * Every tool the server knows about, in the order clients list them.
 * Tier filtering happens in server.ts, not here, so this stays a plain
 * inventory that is easy to audit at a glance.
 */
export const ALL_TOOLS: readonly RegisterableTool[] = [
  healthTool,
  apiSearchTool,
  listWindowsTool,
  focusWindowTool,
  moveWindowTool,
  windowLayoutTool,
  listAppsTool,
  launchAppTool,
  focusAppTool,
  screensTool,
  consoleTailTool,
  notifyTool,
  reloadConfigTool,
  evalTool,
];
