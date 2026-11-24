import { describe, expect, it } from 'vitest';
import { DRAG_PX, dragOffset, edgeAfterDrag } from '@/ui/bar-dock';
import { readingBand } from '@/highlight/highlighter';
import { DEFAULT_SETTINGS, sanitizeSettings, withDefaults, type Settings } from '@/shared/settings';
import { SYNCED_SETTINGS } from '@/sync/synced-settings';

describe('dragging the reading bar between the edges', () => {
  // An 800 px window, the bar 52 px tall resting 20 px above the bottom.
  const top = 728;
  const bottom = 780;

  it('follows the pointer while it stays inside the window', () => {
    expect(dragOffset(-300, top, bottom, 800)).toBe(-300);
    expect(dragOffset(12, top, bottom, 800)).toBe(12);
  });

  it('is held at the window’s edges, not dragged off them', () => {
    expect(dragOffset(-2000, top, bottom, 800)).toBe(-(top - 4));
    expect(dragOffset(500, top, bottom, 800)).toBe(800 - 4 - bottom);
  });

  it('does not move in a window shorter than itself, and ignores nonsense', () => {
    expect(dragOffset(-100, 10, 400, 300)).toBe(0);
    expect(dragOffset(Number.NaN, top, bottom, 800)).toBe(0);
  });

  it('goes to the nearer edge when let go: past the middle is the other one', () => {
    expect(edgeAfterDrag(100, 152, 800)).toBe('top');
    expect(edgeAfterDrag(360, 412, 800)).toBe('top');
    expect(edgeAfterDrag(390, 442, 800)).toBe('bottom');
    expect(edgeAfterDrag(top, bottom, 800)).toBe('bottom');
  });

  it('needs the same few pixels as the video speed button before a press is a drag', () => {
    expect(DRAG_PX).toBe(8);
  });
});

describe('the part of the window a sentence is kept in', () => {
  it('stops short of a bar at the bottom', () => {
    expect(readingBand(800, { bottom: 84 })).toEqual({ top: 0, bottom: 716 });
  });

  it('starts below a bar at the top', () => {
    expect(readingBand(800, { top: 84 })).toEqual({ top: 84, bottom: 800 });
  });

  it('is the window with nothing in the way, and inside a panel that scrolls the article', () => {
    expect(readingBand(800)).toEqual({ top: 0, bottom: 800 });
    // A panel from 50 to 900 under a bar at the top: from the bar's foot to the window's bottom.
    expect(readingBand(800, { top: 84 }, { top: 50, bottom: 900 })).toEqual({ top: 84, bottom: 800 });
    // A panel lower down than the bar: its own top.
    expect(readingBand(800, { top: 84 }, { top: 120, bottom: 700 })).toEqual({ top: 120, bottom: 700 });
  });

  it('never comes to nothing, however much is covered', () => {
    const band = readingBand(100, { top: 90, bottom: 90 });
    expect(band.bottom - band.top).toBeGreaterThan(0);
  });
});

describe('the barDock setting', () => {
  it('is the bottom unless said otherwise, and an old profile gets it', () => {
    expect(DEFAULT_SETTINGS.barDock).toBe('bottom');
    const { barDock: _gone, ...old } = DEFAULT_SETTINGS;
    expect(withDefaults(old as Partial<Settings>).barDock).toBe('bottom');
  });

  it('keeps the top, and turns anything else back into the bottom', () => {
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, barDock: 'top' }).barDock).toBe('top');
    for (const junk of ['left', 'TOP', 1, null, undefined]) {
      expect(sanitizeSettings({ ...DEFAULT_SETTINGS, barDock: junk } as unknown as Settings).barDock).toBe('bottom');
    }
  });

  it('stays on each device: a phone and a computer are held differently', () => {
    expect(SYNCED_SETTINGS as readonly string[]).not.toContain('barDock');
  });
});
