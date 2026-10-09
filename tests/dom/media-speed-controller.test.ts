// @vitest-environment happy-dom
/**
 * Whose rate change was it?
 *
 * Facebook's player puts its own rate back after every seek. Read as the viewer asking for 1×,
 * one click on the progress bar dropped the speed and overwrote the site's remembered speed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaSpeedController } from '@/media-speed/controller';
import { DEFAULT_MEDIA_SPEED } from '@/shared/settings';

/** A media element as a player really presents one: ready, playing, and seekable. */
function player(): HTMLMediaElement {
  const el = document.createElement('audio');
  Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(el, 'seeking', { value: false, writable: true, configurable: true });
  document.body.append(el);
  return el;
}

/** The player moving within the video and restoring the rate it considers its own, as Facebook does. */
function seekAndRestore(el: HTMLMediaElement, to = 1): void {
  el.dispatchEvent(new Event('seeking'));
  el.dispatchEvent(new Event('seeked'));
  el.playbackRate = to;
  el.dispatchEvent(new Event('ratechange'));
}

function start(initialRate: number | null) {
  const remembered: number[] = [];
  const controller = new MediaSpeedController({
    settings: DEFAULT_MEDIA_SPEED,
    initialRate,
    onRate: (rate) => remembered.push(rate),
  });
  controller.start();
  if (initialRate != null) controller.setInitialRate(initialRate, true);
  return { controller, remembered };
}

describe('a rate change from the player, not the viewer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => vi.useRealTimers());

  it('puts the speed back when the player resets it on a seek, and remembers nothing new', () => {
    const el = player();
    const { controller, remembered } = start(1.5);
    expect(el.playbackRate).toBe(1.5);

    for (let i = 0; i < 6; i++) {
      seekAndRestore(el);
      vi.advanceTimersByTime(2000); // a viewer moving around a long video, seek after seek
      expect(el.playbackRate).toBe(1.5);
    }
    // 1× was never the viewer's choice, so it was never remembered for the site.
    expect(remembered).toEqual([1.5]);
    controller.stop();
  });

  it('follows and remembers a speed set from the site’s own menu', () => {
    const el = player();
    const { controller, remembered } = start(1.5);
    // Well clear of any seek or load: this is a viewer using the site's speed menu.
    vi.advanceTimersByTime(5000);
    el.playbackRate = 2;
    el.dispatchEvent(new Event('ratechange'));

    expect(el.playbackRate).toBe(2);
    expect(controller.currentRate).toBe(2);
    expect(remembered).toEqual([1.5, 2]);
    controller.stop();
  });

  it('stops pulling against a player that insists, rather than flickering turn by turn', () => {
    const el = player();
    const { controller } = start(1.5);
    // This player takes the rate straight back, every time. (A real browser raises `ratechange`
    // on every write; happy-dom does not, so the fixture raises it.)
    el.addEventListener('ratechange', () => {
      if (el.playbackRate !== 1) {
        el.playbackRate = 1;
        el.dispatchEvent(new Event('ratechange'));
      }
    });
    seekAndRestore(el);
    expect(el.playbackRate).toBe(1);
    expect(controller.currentRate).toBe(1);
    controller.stop();
  });

  it('leaves a different video to the site, when the speed only came from memory', () => {
    const el = player();
    const { controller } = start(1.5);
    el.dispatchEvent(new Event('emptied')); // the next reel in the feed
    el.dispatchEvent(new Event('loadstart'));
    el.playbackRate = 1;
    el.dispatchEvent(new Event('ratechange'));
    expect(el.playbackRate).toBe(1);
    controller.stop();
  });

  it('carries a speed chosen here onto the next video', () => {
    const el = player();
    const { controller } = start(null);
    controller.setRate(2, true); // as a key press does
    expect(el.playbackRate).toBe(2);
    el.dispatchEvent(new Event('emptied'));
    el.dispatchEvent(new Event('loadstart'));
    el.playbackRate = 1;
    el.dispatchEvent(new Event('ratechange'));
    expect(el.playbackRate).toBe(2);
    controller.stop();
  });

  // The tenth pass: timing alone took real viewer choices for player resets.
  describe('a new speed picked just after a seek is the viewer’s', () => {
    it('follows a different rate chosen 400 ms after a seek', () => {
      const el = player();
      const { controller, remembered } = start(null);
      controller.setRate(2, false);
      el.dispatchEvent(new Event('seeking'));
      el.dispatchEvent(new Event('seeked'));
      vi.advanceTimersByTime(400);
      el.playbackRate = 1.5; // Shift+< on the site, straight after an arrow-key seek
      el.dispatchEvent(new Event('ratechange'));
      expect(el.playbackRate).toBe(1.5);
      expect(controller.currentRate).toBe(1.5);
      expect(remembered.at(-1)).toBe(1.5);
      controller.stop();
    });

    it('follows a different rate chosen 500 ms after pausing and resuming', () => {
      const el = player();
      const { controller } = start(null);
      controller.setRate(2, false);
      el.dispatchEvent(new Event('pause'));
      el.dispatchEvent(new Event('play'));
      el.dispatchEvent(new Event('playing'));
      vi.advanceTimersByTime(500);
      el.playbackRate = 1.25;
      el.dispatchEvent(new Event('ratechange'));
      expect(el.playbackRate).toBe(1.25);
      controller.stop();
    });

    it('still puts the speed back when the player returns to its own rate', () => {
      const el = player();
      const { controller } = start(null);
      controller.setRate(2, false);
      seekAndRestore(el, 1); // Facebook: back to the rate it had before ours
      expect(el.playbackRate).toBe(2);
      controller.stop();
    });

    it('treats a return to a player’s own non-1× default as a reset too', () => {
      const el = player();
      el.defaultPlaybackRate = 1.1;
      const { controller } = start(null);
      controller.setRate(2, false);
      seekAndRestore(el, 1.1);
      expect(el.playbackRate).toBe(2);
      controller.stop();
    });
  });

  // The eleventh pass: neither timing nor value alone tells a player's reset from a choice.
  describe('a choice has input behind it; a reset does not', () => {
    it('AD03: keeps 1× chosen with a click straight after a seek', () => {
      const el = player();
      const { controller, remembered } = start(null);
      controller.setRate(1.75, false);
      el.dispatchEvent(new Event('seeking'));
      el.dispatchEvent(new Event('seeked'));
      vi.advanceTimersByTime(260);
      window.dispatchEvent(new Event('pointerdown')); // the normal-speed button
      el.playbackRate = 1;
      el.dispatchEvent(new Event('ratechange'));
      expect(el.playbackRate).toBe(1);
      expect(controller.currentRate).toBe(1);
      expect(remembered.at(-1)).toBe(1);
      controller.stop();
    });

    it('still puts the speed back when the reset comes out of the seek itself', () => {
      const el = player();
      const { controller } = start(null);
      controller.setRate(1.75, false);
      window.dispatchEvent(new Event('pointerdown')); // the click that seeks…
      vi.advanceTimersByTime(5);
      seekAndRestore(el, 1); // …and the player's reset after it, with no new input
      expect(el.playbackRate).toBe(1.75);
      controller.stop();
    });

    it('AD04: after yielding to an insistent player, a later 1.75× is the viewer’s, and “faster” goes up', () => {
      const el = player();
      const { controller } = start(null);
      controller.setRate(1.75, false);
      let insist = true;
      el.addEventListener('ratechange', () => {
        if (insist && el.playbackRate !== 1) {
          el.playbackRate = 1;
          el.dispatchEvent(new Event('ratechange'));
        }
      });
      seekAndRestore(el, 1);
      expect(controller.currentRate).toBe(1); // Aloud yielded
      insist = false;
      vi.advanceTimersByTime(1500);
      el.playbackRate = 1.75; // the viewer, through the page's own control
      el.dispatchEvent(new Event('ratechange'));
      expect(controller.currentRate).toBe(1.75);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
      expect(el.playbackRate).toBe(1.85);
      controller.stop();
    });
  });
});
