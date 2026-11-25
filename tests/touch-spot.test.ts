import { describe, expect, it } from 'vitest';
import { nearestClear, placeAt, spotAt, windowBox } from '@/media-speed/touch-button';
import { DEFAULT_MEDIA_SPEED, DEFAULT_SETTINGS, sanitizeSettings, withDefaults, type MediaSpeedSettings, type Settings } from '@/shared/settings';

const video = { left: 50, top: 40, width: 640, height: 360 };
const pill = { width: 62, height: 46 };
const view = { width: 800, height: 600 };

describe('where the speed button sits on the video', () => {
  it('on a phone, moved once, it keeps its place on the screen, below a small video too, and turns with it', () => {
    const phone = { width: 390, height: 844 };
    // Dropped below a video that only fills the top of the screen.
    const spot = spotAt(windowBox(phone), pill, 250, 510);
    expect(placeAt(windowBox(phone), pill, spot, phone)).toEqual({ left: 250, top: 510 });
    // The same place for the next video, wherever that one is: the video is not part of it.
    expect(placeAt(windowBox(phone), pill, spot, phone)).toEqual(placeAt(windowBox(phone), pill, spot, phone));
    // Turned sideways: the same part of the screen, still inside it.
    const turned = placeAt(windowBox({ width: 844, height: 390 }), pill, spot, { width: 844, height: 390 });
    expect(turned.left).toBeGreaterThan(500);
    expect(turned.top + pill.height).toBeLessThanOrEqual(390 - 8);
  });

  it('starts at the top-left corner, just inside the video', () => {
    expect(placeAt(video, pill, { x: 0, y: 0 }, view)).toEqual({ left: 60, top: 50 });
  });

  it('is kept on the video and in the window, however far it is dragged', () => {
    expect(placeAt(video, pill, { x: 1, y: 1 }, view)).toEqual({ left: 50 + 640 - 10 - 62, top: 40 + 360 - 10 - 46 });
    const far = spotAt(video, pill, 5000, -300);
    expect(far).toEqual({ x: 1, y: 0 });
    // A video wider than the window: the window's edge wins.
    expect(placeAt({ left: -200, top: 0, width: 1400, height: 600 }, pill, { x: 1, y: 0 }, view).left).toBe(800 - 62 - 8);
  });

  it('keeps its place on the video when the video is resized (full screen, a turned phone)', () => {
    const spot = spotAt(video, pill, 300, 200);
    const there = placeAt(video, pill, spot, view);
    expect(there).toEqual({ left: 300, top: 200 });
    const big = { left: 0, top: 0, width: 800, height: 450 };
    const moved = placeAt(big, pill, spot, view);
    expect(spotAt(big, pill, moved.left, moved.top).x).toBeCloseTo(spot.x, 2);
    expect(spotAt(big, pill, moved.left, moved.top).y).toBeCloseTo(spot.y, 2);
  });
});

describe('the speed button stays off the reading bar', () => {
  // A bar over the bottom of the window from y = 500 to 560; the button is 46 px tall.
  const onBar = (top: number) => top + 46 > 500 && top < 560;

  it('stays where it was put when nothing is in the way', () => {
    expect(nearestClear(100, 50, 400, 12, onBar)).toBe(100);
  });

  it('moves up off the bar, to the nearest clear place', () => {
    const top = nearestClear(480, 50, 520, 12, onBar)!;
    expect(onBar(top)).toBe(false);
    expect(top).toBeLessThan(480);
    // The first clear step, not the top of the video.
    expect(top).toBe(480 - 3 * 12);
  });

  it('goes below the bar when there is no room above it', () => {
    // A video whose top the bar covers: from 500 the first clear place down is 560.
    expect(nearestClear(500, 500, 570, 12, onBar)).toBe(560);
  });

  it('uses the ends of the range, not only whole steps', () => {
    // Only the very top is clear.
    expect(nearestClear(300, 87, 400, 50, (top) => top > 87)).toBe(87);
  });

  it('gives up when the whole video is covered', () => {
    expect(nearestClear(510, 500, 514, 12, onBar)).toBeNull();
    expect(nearestClear(510, 500, 514, 0, onBar)).toBeNull();
  });
});

describe('the speed button setting', () => {
  it('is on by default, and on for a profile saved before it existed', () => {
    expect(DEFAULT_MEDIA_SPEED.showButton).toBe(true);
    const { showButton: _, ...old } = DEFAULT_MEDIA_SPEED;
    expect(withDefaults({ mediaSpeed: old as MediaSpeedSettings }).mediaSpeed.showButton).toBe(true);
  });

  it('is off only when it says so', () => {
    const sanitized = (showButton: unknown) =>
      sanitizeSettings({ ...DEFAULT_SETTINGS, mediaSpeed: { ...DEFAULT_MEDIA_SPEED, showButton } } as unknown as Settings).mediaSpeed.showButton;
    expect(sanitized(false)).toBe(false);
    expect(sanitized(true)).toBe(true);
    expect(sanitized('no')).toBe(true);
    expect(sanitized(undefined)).toBe(true);
  });
});
