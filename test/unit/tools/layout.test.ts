import { describe, expect, it } from 'vitest';

import {
  applyFraction,
  LAYOUT_PRESETS,
  LAYOUT_PRESET_NAMES,
  type LayoutFraction,
} from '../../../src/tools/safe/layout.js';

const PRESETS = Object.entries(LAYOUT_PRESETS) as [string, LayoutFraction][];

/** A typical built-in display: origin at zero, menu bar already excluded. */
const PRIMARY = { x: 0, y: 25, w: 1512, h: 907 };

/** A second monitor placed to the left, so its origin is negative. */
const SECONDARY = { x: -2560, y: -400, w: 2560, h: 1440 };

describe('preset table', () => {
  it('exposes every preset in the name list', () => {
    expect(LAYOUT_PRESET_NAMES.sort()).toEqual(Object.keys(LAYOUT_PRESETS).sort());
  });

  it.each(PRESETS)('%s stays inside the screen', (_name, fraction) => {
    expect(fraction.x).toBeGreaterThanOrEqual(0);
    expect(fraction.y).toBeGreaterThanOrEqual(0);
    expect(fraction.w).toBeGreaterThan(0);
    expect(fraction.h).toBeGreaterThan(0);
    // Floating point thirds need a tolerance rather than an exact comparison.
    expect(fraction.x + fraction.w).toBeLessThanOrEqual(1.0001);
    expect(fraction.y + fraction.h).toBeLessThanOrEqual(1.0001);
  });

  it('places the half presets so each pair tiles the screen exactly', () => {
    const left = LAYOUT_PRESETS['left-half'];
    const right = LAYOUT_PRESETS['right-half'];
    expect(left.w + right.w).toBe(1);
    expect(left.x + left.w).toBe(right.x);

    const top = LAYOUT_PRESETS['top-half'];
    const bottom = LAYOUT_PRESETS['bottom-half'];
    expect(top.h + bottom.h).toBe(1);
    expect(top.y + top.h).toBe(bottom.y);
  });

  it('places the thirds so they tile without a gap or overlap', () => {
    const left = LAYOUT_PRESETS['thirds-left'];
    const middle = LAYOUT_PRESETS['thirds-center'];
    const right = LAYOUT_PRESETS['thirds-right'];

    expect(left.x).toBe(0);
    expect(left.x + left.w).toBeCloseTo(middle.x, 10);
    expect(middle.x + middle.w).toBeCloseTo(right.x, 10);
    expect(right.x + right.w).toBeCloseTo(1, 10);
  });

  it('places the four quarters so together they cover the screen', () => {
    const quarters = [
      LAYOUT_PRESETS['quarter-top-left'],
      LAYOUT_PRESETS['quarter-top-right'],
      LAYOUT_PRESETS['quarter-bottom-left'],
      LAYOUT_PRESETS['quarter-bottom-right'],
    ];
    const area = quarters.reduce((sum, quarter) => sum + quarter.w * quarter.h, 0);
    expect(area).toBeCloseTo(1, 10);
    // No two quarters share an origin, so none is a duplicate.
    const origins = new Set(quarters.map((quarter) => `${quarter.x},${quarter.y}`));
    expect(origins.size).toBe(4);
  });

  it('makes maximize fill everything and center visibly smaller', () => {
    expect(LAYOUT_PRESETS.maximize).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const center = LAYOUT_PRESETS.center;
    expect(center.w).toBeLessThan(1);
    // Centred means equal margins on both axes.
    expect(center.x).toBeCloseTo((1 - center.w) / 2, 10);
    expect(center.y).toBeCloseTo((1 - center.h) / 2, 10);
  });

  it('makes the two-thirds presets exactly twice a third', () => {
    expect(LAYOUT_PRESETS['two-thirds-left'].w).toBeCloseTo(
      LAYOUT_PRESETS['thirds-left'].w * 2,
      10
    );
    expect(LAYOUT_PRESETS['two-thirds-right'].x + LAYOUT_PRESETS['two-thirds-right'].w).toBeCloseTo(
      1,
      10
    );
  });
});

describe('applyFraction', () => {
  it('places left-half against a primary screen whose origin is not the top of the display', () => {
    expect(applyFraction(LAYOUT_PRESETS['left-half'], PRIMARY)).toEqual({
      x: 0,
      y: 25,
      w: 756,
      h: 907,
    });
  });

  it('places right-half at the horizontal midpoint', () => {
    expect(applyFraction(LAYOUT_PRESETS['right-half'], PRIMARY)).toEqual({
      x: 756,
      y: 25,
      w: 756,
      h: 907,
    });
  });

  // The case that a naive implementation gets wrong: it must offset by the
  // screen origin rather than assuming the screen starts at zero.
  it('respects a negative origin on a second monitor', () => {
    expect(applyFraction(LAYOUT_PRESETS['left-half'], SECONDARY)).toEqual({
      x: -2560,
      y: -400,
      w: 1280,
      h: 1440,
    });
    expect(applyFraction(LAYOUT_PRESETS['right-half'], SECONDARY)).toEqual({
      x: -1280,
      y: -400,
      w: 1280,
      h: 1440,
    });
  });

  it('maximize exactly reproduces the screen frame', () => {
    for (const screen of [PRIMARY, SECONDARY]) {
      expect(applyFraction(LAYOUT_PRESETS.maximize, screen)).toEqual(screen);
    }
  });

  it.each(PRESETS)('%s never places a window outside its screen', (_name, fraction) => {
    for (const screen of [PRIMARY, SECONDARY]) {
      const placed = applyFraction(fraction, screen);
      expect(placed.x).toBeGreaterThanOrEqual(screen.x - 0.001);
      expect(placed.y).toBeGreaterThanOrEqual(screen.y - 0.001);
      expect(placed.x + placed.w).toBeLessThanOrEqual(screen.x + screen.w + 0.001);
      expect(placed.y + placed.h).toBeLessThanOrEqual(screen.y + screen.h + 0.001);
    }
  });

  it('keeps a bottom-half window below the vertical midpoint', () => {
    const placed = applyFraction(LAYOUT_PRESETS['bottom-half'], PRIMARY);
    expect(placed.y).toBe(PRIMARY.y + PRIMARY.h / 2);
    expect(placed.y + placed.h).toBe(PRIMARY.y + PRIMARY.h);
  });
});
