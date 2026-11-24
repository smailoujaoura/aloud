import { describe, expect, it } from 'vitest';
import { BAR_GAP, PANEL_MARGIN, clearOfBar, findBox, movedHeight, placePanel, spotOfPanel, validSpot } from '@/annotate/panel-place';

const view = { width: 1280, height: 800 };
const panel = { width: 360, height: 560 };

describe('where a moved notes panel sits', () => {
  it('goes from the top-left corner to the bottom-right one, just inside the window', () => {
    expect(placePanel({ x: 0, y: 0 }, panel, view)).toEqual({ left: PANEL_MARGIN, top: PANEL_MARGIN });
    expect(placePanel({ x: 1, y: 1 }, panel, view)).toEqual({ left: 1280 - 360 - 12, top: 800 - 560 - 12 });
  });

  it('is kept fully inside the window however far it is dragged', () => {
    expect(spotOfPanel(-500, -500, panel, view)).toEqual({ x: 0, y: 0 });
    expect(spotOfPanel(5000, 5000, panel, view)).toEqual({ x: 1, y: 1 });
    // A window smaller than the panel: pinned to the margin, not pushed off the top or left.
    expect(placePanel({ x: 1, y: 1 }, panel, { width: 300, height: 400 })).toEqual({ left: 12, top: 12 });
  });

  it('keeps its place across a resize: a panel in the corner stays in the corner', () => {
    const spot = spotOfPanel(1280 - 360 - 12, 120, panel, view);
    expect(spot.x).toBe(1);
    const wider = { width: 1920, height: 1000 };
    expect(placePanel(spot, panel, wider).left).toBe(1920 - 360 - 12);
    const back = placePanel(spotOfPanel(400, 120, panel, view), panel, view);
    expect(back).toEqual({ left: 400, top: 120 });
  });

  it('is no taller than 560 px, and no taller than the window leaves', () => {
    expect(movedHeight({ width: 1280, height: 1200 })).toBe(560);
    expect(movedHeight({ width: 1280, height: 500 })).toBe(500 - 2 * PANEL_MARGIN);
  });

  it('reads back only a real spot from storage', () => {
    expect(validSpot({ x: 0.25, y: 0.5 })).toEqual({ x: 0.25, y: 0.5 });
    expect(validSpot({ x: 3, y: -1 })).toEqual({ x: 1, y: 0 });
    for (const bad of [null, undefined, 'left', { x: 'a', y: 0 }, { x: Number.NaN, y: 0 }, { x: 1 }]) expect(validSpot(bad)).toBeNull();
  });
});

describe('a moved notes panel and the reading bar', () => {
  const bottomBar = { left: 180, top: 800 - 20 - 64, width: 920, height: 64 };

  it('stays exactly where it is when it is clear of the bar, or there is no bar', () => {
    const box = { left: 12, top: 12, width: 360, height: 560 };
    expect(clearOfBar(box, null, view)).toBe(box);
    expect(clearOfBar({ ...box, left: 900, top: 100 }, bottomBar, view)).toEqual({ ...box, left: 900, top: 100 });
  });

  it('is moved up off a bar at the bottom', () => {
    const under = { left: 400, top: 228, width: 360, height: 560 };
    expect(clearOfBar(under, bottomBar, view)).toEqual({ ...under, top: bottomBar.top - BAR_GAP - 560 });
  });

  it('is moved down off a bar at the top', () => {
    const topBar = { left: 180, top: 20, width: 920, height: 64 };
    const under = { left: 400, top: 12, width: 360, height: 560 };
    expect(clearOfBar(under, topBar, view)).toEqual({ ...under, top: 20 + 64 + BAR_GAP });
  });

  it('goes to the side instead when that is the shorter way', () => {
    // Just over the bar's right end: 48 px to the right rather than 80 up.
    const over = { left: 1060, top: 228, width: 160, height: 560 };
    expect(clearOfBar(over, bottomBar, view)).toEqual({ ...over, left: 180 + 920 + BAR_GAP });
  });

  it('is made shorter when the window is too short to move it clear', () => {
    const short = { width: 1280, height: 600 };
    const bar = { left: 0, top: 600 - 84, width: 1280, height: 84 };
    const box = { left: 400, top: 12, width: 360, height: 576 };
    expect(clearOfBar(box, bar, short)).toEqual({ ...box, top: 12, height: 600 - 84 - BAR_GAP - 12 });
  });
});

describe('finding the reading bar on screen', () => {
  const view = { width: 1280, height: 800 };
  const at = (box: { left: number; top: number; width: number; height: number }) => (x: number, y: number) =>
    x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

  it('finds its box to within a few pixels, past the region it was looked for in', () => {
    const bar = { left: 180, top: 716, width: 920, height: 64 };
    const found = findBox({ left: 400, top: 228, width: 360, height: 560 }, { x: 48, y: 16 }, view, at(bar))!;
    expect(Math.abs(found.left - bar.left)).toBeLessThanOrEqual(4);
    expect(Math.abs(found.top - bar.top)).toBeLessThanOrEqual(4);
    expect(Math.abs(found.left + found.width - (bar.left + bar.width))).toBeLessThanOrEqual(4);
    expect(Math.abs(found.top + found.height - (bar.top + bar.height))).toBeLessThanOrEqual(4);
    // Never smaller than the bar: what it covers is what is kept clear.
    expect(found.left).toBeLessThanOrEqual(bar.left);
    expect(found.top + found.height).toBeGreaterThanOrEqual(bar.top + bar.height);
  });

  it('finds nothing where nothing is', () => {
    expect(findBox({ left: 0, top: 0, ...view }, { x: 64, y: 16 }, view, () => false)).toBeNull();
  });

  it('looks at few enough points to stay quick', () => {
    let calls = 0;
    const bar = at({ left: 180, top: 716, width: 920, height: 64 });
    findBox({ left: 0, top: 0, ...view }, { x: 64, y: 16 }, view, (x, y) => (calls++, bar(x, y)));
    expect(calls).toBeLessThan(1600);
  });
});
