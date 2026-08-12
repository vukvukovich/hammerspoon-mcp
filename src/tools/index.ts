import { apiSearchTool } from './safe/api-search.js';
import { audioDevicesTool, audioSetDeviceTool, audioVolumeTool } from './safe/audio.js';
import { brightnessTool, machineStatusTool, mediaControlTool } from './safe/machine.js';
import { notifyCenterTool, peripheralsTool, wifiTool } from './safe/hardware.js';
import { caffeinateTool, lockScreenTool } from './safe/session.js';
import { listShortcutsTool, runShortcutTool } from './safe/shortcuts.js';
import { gotoSpaceTool, listSpacesTool } from './safe/spaces.js';
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
  listSpacesTool,
  gotoSpaceTool,
  audioDevicesTool,
  audioSetDeviceTool,
  audioVolumeTool,
  brightnessTool,
  mediaControlTool,
  machineStatusTool,
  peripheralsTool,
  wifiTool,
  notifyCenterTool,
  caffeinateTool,
  lockScreenTool,
  listShortcutsTool,
  runShortcutTool,
  consoleTailTool,
  notifyTool,
  reloadConfigTool,
  evalTool,
];
