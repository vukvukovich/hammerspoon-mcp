import { z } from 'zod';

import { defineTool, fromBridge } from '../registry.js';
import { lua } from '../../bridge/lua.js';

/**
 * Named window layouts.
 *
 * Presets are stored as fractions of the target screen rather than pixels, so
 * the same table works on any display and on a second monitor whose origin is
 * not zero. TypeScript owns the fractions (this table is the specification and
 * is unit tested exhaustively) and Lua does the one multiplication against the
 * live screen frame, which keeps the whole operation to a single round trip.
 *
 * Fractions apply to the screen's `frame`, which already excludes the menu bar
 * and the Dock. Using `fullFrame` would tuck windows underneath both.
 */
export type LayoutFraction = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

const THIRD = 1 / 3;

/** Fraction of the screen occupied by each preset. */
export const LAYOUT_PRESETS = {
  'left-half': { x: 0, y: 0, w: 0.5, h: 1 },
  'right-half': { x: 0.5, y: 0, w: 0.5, h: 1 },
  'top-half': { x: 0, y: 0, w: 1, h: 0.5 },
  'bottom-half': { x: 0, y: 0.5, w: 1, h: 0.5 },
  maximize: { x: 0, y: 0, w: 1, h: 1 },
  // Not full size, so "center" is visibly distinct from "maximize".
  center: { x: 0.15, y: 0.15, w: 0.7, h: 0.7 },
  'thirds-left': { x: 0, y: 0, w: THIRD, h: 1 },
  'thirds-center': { x: THIRD, y: 0, w: THIRD, h: 1 },
  'thirds-right': { x: 2 * THIRD, y: 0, w: THIRD, h: 1 },
  'two-thirds-left': { x: 0, y: 0, w: 2 * THIRD, h: 1 },
  'two-thirds-right': { x: THIRD, y: 0, w: 2 * THIRD, h: 1 },
  'quarter-top-left': { x: 0, y: 0, w: 0.5, h: 0.5 },
  'quarter-top-right': { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  'quarter-bottom-left': { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  'quarter-bottom-right': { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
} as const satisfies Record<string, LayoutFraction>;

export type LayoutPreset = keyof typeof LAYOUT_PRESETS;

export const LAYOUT_PRESET_NAMES = Object.keys(LAYOUT_PRESETS) as [LayoutPreset, ...LayoutPreset[]];

/**
 * Reference implementation of the placement Lua performs.
 *
 * Kept in TypeScript so the arithmetic is unit testable against synthetic
 * screens, including a second monitor with a negative origin. The Lua below
 * performs the identical calculation, and an integration test compares the two
 * against a real screen so they cannot drift silently.
 */
export function applyFraction(
  fraction: LayoutFraction,
  screen: { x: number; y: number; w: number; h: number }
): { x: number; y: number; w: number; h: number } {
  return {
    x: screen.x + screen.w * fraction.x,
    y: screen.y + screen.h * fraction.y,
    w: screen.w * fraction.w,
    h: screen.h * fraction.h,
  };
}

const WINDOW_LAYOUT_LUA = lua`
local target
if ARGS.windowId then
  target = hs.window.get(ARGS.windowId)
  if not target then error("no window has id " .. tostring(ARGS.windowId), 0) end
else
  target = hs.window.focusedWindow()
  if not target then error("no window is focused, so there is nothing to lay out", 0) end
end

local screen
if ARGS.screenIndex then
  local screens = hs.screen.allScreens()
  screen = screens[ARGS.screenIndex + 1]
  if not screen then
    error("no screen at index " .. tostring(ARGS.screenIndex) .. ", found " .. tostring(#screens), 0)
  end
else
  screen = target:screen()
  if not screen then error("could not determine the window's screen", 0) end
end

-- frame excludes the menu bar and Dock; fullFrame would hide edges underneath them.
local f = screen:frame()
local r = ARGS.rect
target:setFrame({
  x = f.x + f.w * r.x,
  y = f.y + f.h * r.y,
  w = f.w * r.w,
  h = f.h * r.h,
})

local placed = target:frame()
return {
  id = target:id(),
  preset = ARGS.preset,
  screen = screen:name() or "",
  screenFrame = { x = f.x, y = f.y, w = f.w, h = f.h },
  frame = { x = placed.x, y = placed.y, w = placed.w, h = placed.h },
}
`;

export const windowLayoutTool = defineTool({
  name: 'hs_window_layout',
  tier: 'safe',
  title: 'Apply a window layout preset',
  description:
    'Snap a window to a named position such as left-half or quarter-top-left, computed from the screen size so no pixel arithmetic is needed. Defaults to the focused window. Positions respect the menu bar and Dock.',
  inputSchema: z.object({
    preset: z.enum(LAYOUT_PRESET_NAMES).describe('Named layout to apply.'),
    windowId: z
      .number()
      .int()
      .optional()
      .describe('Window id from hs_list_windows. Defaults to the focused window.'),
    screenIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based screen index from hs_screens. Defaults to the screen the window is already on. Use this to move a window to another display and position it in one call.'
      ),
  }),
  handler: async (args, { bridge }) =>
    fromBridge(
      await bridge.run(WINDOW_LAYOUT_LUA, {
        preset: args.preset,
        rect: LAYOUT_PRESETS[args.preset],
        ...(args.windowId === undefined ? {} : { windowId: args.windowId }),
        ...(args.screenIndex === undefined ? {} : { screenIndex: args.screenIndex }),
      })
    ),
});
