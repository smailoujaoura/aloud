import { describe, expect, it } from 'vitest';
import { placeAt, spotAt } from '@/media-speed/touch-button';

const video = { left: 50, top: 40, width: 640, height: 360 };
const pill = { width: 62, height: 46 };
const view = { width: 800, height: 600 };

describe('where the phone speed button sits on the video', () => {
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
