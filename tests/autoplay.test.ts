import { describe, expect, it } from 'vitest';
import { AutoplayGuard, GESTURE_MS, HANDOVER_MS } from '@/media-speed/autoplay';

/** Just enough of a media element: events, `paused`, and a `pause()` that fires `pause`. */
class FakeMedia extends EventTarget {
  paused = true;
  play(): void {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    if (!this.paused) this.dispatchEvent(new Event('playing'));
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  end(): void {
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

function setup(opts: { leavePlaying?: boolean; enabled?: boolean } = {}) {
  let now = 100_000;
  const notices: unknown[] = [];
  const guard = new AutoplayGuard({
    enabled: opts.enabled ?? true,
    leavePlaying: opts.leavePlaying ?? false,
    notice: (m) => notices.push(m),
    now: () => now,
    activated: () => false,
  });
  const gestures = new EventTarget();
  guard.watchGestures(gestures);
  const gesture = () => {
    const e = new Event('keydown');
    Object.defineProperty(e, 'isTrusted', { value: true });
    gestures.dispatchEvent(e);
  };
  const media = () => {
    const m = new FakeMedia();
    guard.track(m as unknown as HTMLMediaElement);
    return m;
  };
  return { guard, notices, gesture, media, advance: (ms: number) => (now += ms) };
}

describe('the autoplay guard', () => {
  it('pauses a video that starts by itself, and says so', () => {
    const { media, notices } = setup();
    const video = media();
    video.play();
    expect(video.paused).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('lets a video you started play — Space, a click', () => {
    const { media, gesture, notices } = setup();
    const video = media();
    gesture();
    video.play();
    expect(video.paused).toBe(false);
    expect(notices).toHaveLength(0);
  });

  it('still counts a click a moment before the player gets going (a single-page site)', () => {
    const { media, gesture, advance } = setup();
    const video = media();
    gesture();
    advance(GESTURE_MS - 500);
    video.play();
    expect(video.paused).toBe(false);
  });

  it('stops the next video in a feed long after your last click', () => {
    const { media, gesture, advance } = setup();
    const first = media();
    gesture();
    first.play();
    advance(60_000);
    first.end();
    advance(HANDOVER_MS + 3000); // the "up next" countdown
    const next = media();
    next.play();
    expect(next.paused).toBe(true);
  });

  it('lets the video you started carry on after its ad', () => {
    const { media, gesture, advance } = setup();
    const player = media();
    gesture();
    player.play(); // the ad
    advance(15_000);
    player.end();
    advance(300);
    player.play(); // the video, same element, new source
    expect(player.paused).toBe(false);
  });

  it('does not take its own pause as playback ending', () => {
    const { media, advance } = setup();
    const video = media();
    video.play(); // stopped by the guard
    advance(200);
    video.play(); // the site trying again
    expect(video.paused).toBe(true);
  });

  it('with the page: pauses what is already playing when it is found', () => {
    const { guard, notices } = setup();
    const video = new FakeMedia();
    video.paused = false; // started before the guard saw it
    guard.track(video as unknown as HTMLMediaElement);
    expect(video.paused).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('from the shortcut: leaves what you are already watching alone', () => {
    const { guard } = setup({ leavePlaying: true });
    const video = new FakeMedia();
    video.paused = false;
    guard.track(video as unknown as HTMLMediaElement);
    guard.settle();
    expect(video.paused).toBe(false);
  });

  it('does nothing while switched off', () => {
    const { media } = setup({ enabled: false });
    const video = media();
    video.play();
    expect(video.paused).toBe(false);
  });

  it('ignores synthetic clicks and keys a page makes up', () => {
    const { media, guard } = setup();
    const fake = new EventTarget();
    guard.watchGestures(fake);
    fake.dispatchEvent(new Event('pointerdown')); // not trusted
    const video = media();
    video.play();
    expect(video.paused).toBe(true);
  });
});
