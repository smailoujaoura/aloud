// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MediaSpeedController } from '@/media-speed/controller';
import { DEFAULT_MEDIA_SPEED } from '@/shared/settings';

function setup(initialRate: number | null) {
  document.body.innerHTML = '<video id="v"></video>';
  const video = document.getElementById('v') as HTMLVideoElement;
  const rates: number[] = [];
  const controller = new MediaSpeedController({
    settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
    initialRate,
    onRate: (r) => rates.push(r),
  });
  controller.start();
  return { controller, video, rates };
}

/** What a player does while you drag its progress bar: reset the rate, then reload and play. */
function scrub(video: HTMLVideoElement): void {
  video.playbackRate = 1;
  video.dispatchEvent(new Event('ratechange'));
  for (const type of ['canplay', 'play', 'playing', 'durationchange']) video.dispatchEvent(new Event(type));
}

describe('MediaSpeedController', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('offers a remembered speed once, and does not put it back when the player resets it', () => {
    const { controller, video } = setup(1.75);
    controller.setInitialRate(1.75);
    expect(video.playbackRate).toBe(1.75);
    scrub(video);
    expect(video.playbackRate).toBe(1);
    expect(controller.currentRate).toBe(1);
  });

  it('keeps a speed you chose here through a reset and a new source', () => {
    const { controller, video } = setup(null);
    controller.setRate(2);
    expect(video.playbackRate).toBe(2);
    video.playbackRate = 1;
    video.dispatchEvent(new Event('loadstart'));
    expect(video.playbackRate).toBe(2);
  });

  it('follows the site’s own speed menu, and keeps that through a reset', () => {
    const { controller, video } = setup(1.75);
    controller.setInitialRate(1.75);
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    video.playbackRate = 1.25;
    video.dispatchEvent(new Event('ratechange'));
    expect(controller.currentRate).toBe(1.25);
    video.playbackRate = 1;
    video.dispatchEvent(new Event('loadstart'));
    expect(video.playbackRate).toBe(1.25);
  });

  it('does not take a reset during loading as a choice', () => {
    const { controller, video } = setup(1.75);
    controller.setInitialRate(1.75);
    Object.defineProperty(video, 'readyState', { value: 0, configurable: true });
    scrub(video);
    expect(video.playbackRate).toBe(1);
    expect(controller.currentRate).toBe(1);
  });
});

describe('players that leave the page', () => {
  it('are let go of, rather than kept for the life of the controller', () => {
    document.body.innerHTML = '<video id="a"></video><video id="b"></video>';
    const controller = new MediaSpeedController({
      settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
      initialRate: null,
      onRate: () => {},
    });
    controller.start();
    expect(controller.mediaCount).toBe(2);
    document.getElementById('a')!.remove();
    expect(controller.mediaCount).toBe(1);
    controller.stop();
  });

  it('keep no cleanup for a removed player: a feed of a thousand cards holds nothing it threw away', () => {
    document.body.innerHTML = '';
    const controller = new MediaSpeedController({
      settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
      initialRate: null,
      onRate: () => {},
    });
    controller.start();
    const inner = controller as unknown as { cleanups: unknown[]; listeners: Map<unknown, unknown> };
    const before = inner.cleanups.length;
    for (let i = 0; i < 50; i++) {
      const v = document.createElement('video');
      document.body.append(v);
      (controller as unknown as { scan(): void }).scan();
      v.remove();
      expect(controller.mediaCount).toBe(0);
    }
    expect(inner.listeners.size).toBe(0);
    expect(inner.cleanups.length).toBe(before);
    controller.stop();
  });

  it('still unhooks the players that are left when the control stops', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    const controller = new MediaSpeedController({
      settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
      initialRate: 2,
      onRate: () => {},
    });
    controller.start();
    controller.setRate(2, false);
    controller.stop();
    video.playbackRate = 1;
    video.dispatchEvent(new Event('play')); // a stopped control must not put its rate back
    expect(video.playbackRate).toBe(1);
  });
});
