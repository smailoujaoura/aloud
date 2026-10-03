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

describe('rewind and skip forward (YouTube Shorts has neither)', () => {
  function player(id: string, opts: { duration: number; time: number; playing: boolean; box: [number, number] }) {
    const v = document.createElement('video');
    v.id = id;
    let t = opts.time;
    Object.defineProperty(v, 'duration', { value: opts.duration, configurable: true });
    Object.defineProperty(v, 'currentTime', { get: () => t, set: (x: number) => (t = x), configurable: true });
    Object.defineProperty(v, 'paused', { value: !opts.playing, configurable: true });
    v.getBoundingClientRect = () => ({ left: 0, top: 0, right: opts.box[0], bottom: opts.box[1], width: opts.box[0], height: opts.box[1], x: 0, y: 0, toJSON() {} }) as DOMRect;
    document.body.append(v);
    return v;
  }
  const press = (key: string) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true }));

  function start() {
    const controller = new MediaSpeedController({
      settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false, seekSeconds: 10 },
      initialRate: null,
      onRate: () => {},
    });
    controller.start();
    return controller;
  }

  it('Z goes back and X forward, on the clip that is playing — not the ones loaded beside it', () => {
    document.body.innerHTML = '';
    const previous = player('prev', { duration: 40, time: 30, playing: false, box: [400, 700] });
    const current = player('cur', { duration: 58, time: 23, playing: true, box: [400, 700] });
    const controller = start();
    press('z');
    expect(current.currentTime).toBe(13);
    press('x');
    press('x');
    expect(current.currentTime).toBe(33);
    expect(previous.currentTime).toBe(30);
    controller.stop();
  });

  it('stops at the start and just short of the end', () => {
    document.body.innerHTML = '';
    const v = player('v', { duration: 20, time: 4, playing: true, box: [400, 700] });
    const controller = start();
    press('z');
    expect(v.currentTime).toBe(0);
    press('x');
    press('x');
    press('x');
    expect(v.currentTime).toBeCloseTo(19.9);
    controller.stop();
  });

  it('leaves the key alone while typing', () => {
    document.body.innerHTML = '<input id="i">';
    const v = player('v', { duration: 60, time: 30, playing: true, box: [400, 700] });
    const controller = start();
    const input = document.getElementById('i')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true, composed: true }));
    expect(v.currentTime).toBe(30);
    controller.stop();
  });
});
