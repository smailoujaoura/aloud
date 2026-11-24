// @vitest-environment happy-dom
/**
 * Moving within a video must not change its speed.
 *
 * "Dragging or clicking the progress bar somehow changes the speed on some websites." Each case
 * here is a way a real player behaves around a seek. Unlike the fixtures in
 * tests/dom/media-speed-controller.test.ts, the player below behaves as a browser does: setting
 * `playbackRate` or `currentTime` queues its `ratechange` or `seeking` as a task, in the order the
 * properties were set, and `seeking` is true from the moment `currentTime` is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaSpeedController } from '@/media-speed/controller';
import { DEFAULT_MEDIA_SPEED } from '@/shared/settings';

/** How long a seek takes to complete: data already buffered. */
const SEEK_MS = 30;

type Player = HTMLVideoElement & {
  /**
   * The browser's media element load algorithm, as when a player sets a new `src`. `silent`: the
   * rate goes back to the default without a `ratechange`, as not every browser fires one there.
   */
  reload(src: string, silent?: boolean): void;
};

/** A `<video>` that queues its events as a browser does. Not yet on the page. */
function video(src = 'https://cdn.example.org/clip.mp4'): Player {
  const el = document.createElement('video') as Player;
  let rate = 1;
  let time = 0;
  let seeking = false;
  let ready = 4;
  const task = (type: string, before?: () => void, ms = 0): void =>
    void setTimeout(() => {
      before?.();
      el.dispatchEvent(new Event(type));
    }, ms);
  Object.defineProperty(el, 'playbackRate', {
    configurable: true,
    get: () => rate,
    set: (value: number) => {
      if (Number(value) === rate) return; // a browser fires nothing for an unchanged rate
      rate = Number(value);
      task('ratechange');
    },
  });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = Number(value);
      seeking = true; // at once, before any event
      task('seeking');
      task('timeupdate', () => void (seeking = false), SEEK_MS);
      task('seeked', undefined, SEEK_MS);
    },
  });
  Object.defineProperty(el, 'seeking', { configurable: true, get: () => seeking });
  Object.defineProperty(el, 'readyState', { configurable: true, get: () => ready });
  Object.defineProperty(el, 'paused', { configurable: true, value: false });
  Object.defineProperty(el, 'duration', { configurable: true, value: 600 });
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, bottom: 360, right: 640, width: 640, height: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  el.setAttribute('src', src);
  el.reload = (next: string, silent = false) => {
    el.setAttribute('src', next);
    ready = 0;
    seeking = false;
    task('emptied');
    // The load algorithm puts the rate back to the default, as a write to `playbackRate` would.
    if (silent) rate = el.defaultPlaybackRate;
    else el.playbackRate = el.defaultPlaybackRate;
    task('loadstart');
    task('durationchange', undefined, 40);
    task('loadeddata', () => void (ready = 2), 60);
    task('canplay', () => void (ready = 4), 80);
    task('playing', undefined, 90);
  };
  return el;
}

/** The player's progress bar, under the video. */
function progressBar(): HTMLElement {
  const bar = document.createElement('div');
  document.body.append(bar);
  return bar;
}

/** A click as the browser delivers one: press, release, click, `held` ms apart. */
function click(target: Element, held = 80): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  vi.advanceTimersByTime(held);
  target.dispatchEvent(new Event('pointerup', { bubbles: true }));
  target.dispatchEvent(new Event('click', { bubbles: true }));
}

function press(key: string): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }));
}

/** Every controller a test started: stopped after it, passed or failed, so none outlives its test. */
const running: MediaSpeedController[] = [];

/** Aloud running, with `initialRate` as the site's speed: `remembered` lists what it stores. */
function start(initialRate: number | null) {
  const remembered: number[] = [];
  const controller = new MediaSpeedController({
    settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
    initialRate,
    onRate: (rate) => remembered.push(rate),
  });
  running.push(controller);
  controller.start();
  if (initialRate != null) controller.setInitialRate(initialRate);
  vi.advanceTimersByTime(5000); // well into the video before anyone seeks
  return { controller, remembered };
}

/** A speed chosen here, with Aloud's key, well before the seek. */
function choose(times: number): void {
  for (let i = 0; i < times; i++) press('d');
  vi.advanceTimersByTime(5000);
}

describe('a seek leaves the speed alone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    for (const controller of running.splice(0)) controller.stop();
    vi.useRealTimers();
  });

  describe('a player resetting the rate inside the click that seeks', () => {
    it('resetting it before setting the position: not taken as the viewer choosing 1×', () => {
      const el = video();
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => {
        el.playbackRate = 1; // its own rate first…
        el.currentTime = 120; // …then the seek: `ratechange` is queued ahead of `seeking`
      });
      const { controller, remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(controller.currentRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('resetting it after setting the position', () => {
      const el = video();
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => {
        el.currentTime = 120;
        el.playbackRate = 1;
      });
      const { remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('seeking on the press and resetting the rate on the click that ends it', () => {
      const el = video();
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('pointerdown', () => void (el.currentTime = 120));
      bar.addEventListener('click', () => void (el.playbackRate = 1));
      const { remembered } = start(null);
      choose(2); // 1.5×, with Aloud's key
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.25, 1.5]);
    });

    it('a long drag: seeking while held, the rate reset on release two seconds later', () => {
      const el = video();
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('pointerdown', () => void (el.currentTime = 120));
      bar.addEventListener('pointerup', () => void (el.playbackRate = 1));
      const { remembered } = start(1.5);
      click(bar, 2000);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('but a speed picked in the site’s menu straight after a seek is still the viewer’s', () => {
      const el = video();
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => {
        el.playbackRate = 1;
        el.currentTime = 120;
      });
      const normal = document.createElement('button'); // the site's "Normal" speed
      normal.addEventListener('click', () => void (el.playbackRate = 1));
      document.body.append(normal);
      const { controller, remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(300);
      click(normal);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1);
      expect(controller.currentRate).toBe(1);
      expect(remembered.at(-1)).toBe(1);
    });

    it('and a speed picked while a slow seek is still loading is the viewer’s too', () => {
      const el = video();
      document.body.append(el);
      const { remembered } = start(1.5);
      Object.defineProperty(el, 'seeking', { configurable: true, value: true }); // waiting for data
      el.dispatchEvent(new Event('seeking'));
      vi.advanceTimersByTime(3000);
      const normal = document.createElement('button');
      normal.addEventListener('click', () => void (el.playbackRate = 1));
      document.body.append(normal);
      click(normal);
      vi.advanceTimersByTime(10);
      expect(el.playbackRate).toBe(1);
      expect(remembered.at(-1)).toBe(1);
    });
  });

  it('a player restoring its rate on `seeked` (Facebook)', () => {
    const el = video();
    document.body.append(el);
    el.addEventListener('seeked', () => void (el.playbackRate = 1));
    const bar = progressBar();
    bar.addEventListener('click', () => void (el.currentTime = 120));
    const { remembered } = start(1.5);
    for (let i = 0; i < 5; i++) {
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
    }
    expect(remembered).toEqual([1.5]);
  });

  it('a player restoring its rate on every event of the seek', () => {
    const el = video();
    document.body.append(el);
    for (const type of ['seeking', 'timeupdate', 'seeked']) el.addEventListener(type, () => void (el.playbackRate = 1));
    const bar = progressBar();
    bar.addEventListener('click', () => void (el.currentTime = 120));
    const { remembered } = start(1.5);
    click(bar);
    vi.advanceTimersByTime(2000);
    expect(el.playbackRate).toBe(1.5);
    expect(remembered).toEqual([1.5]);
  });

  it('a player restoring its own speed setting, not 1×, chosen earlier in its own menu', () => {
    const el = video();
    document.body.append(el);
    let own = 1; // the player's own speed setting
    const menu = document.createElement('button'); // its "1.25" item
    menu.addEventListener('click', () => void (el.playbackRate = own = 1.25));
    document.body.append(menu);
    el.addEventListener('seeked', () => void (el.playbackRate = own));
    const bar = progressBar();
    bar.addEventListener('click', () => void (el.currentTime = 120));
    const { controller, remembered } = start(null);
    choose(2); // 1.5× with Aloud's key
    click(menu); // then 1.25× in the site's own menu
    vi.advanceTimersByTime(5000);
    expect(controller.currentRate).toBe(1.25);
    choose(1); // and back to 1.5× with Aloud's key
    expect(el.playbackRate).toBe(1.5);
    click(bar);
    vi.advanceTimersByTime(2000);
    expect(el.playbackRate).toBe(1.5);
    expect(controller.currentRate).toBe(1.5);
    expect(remembered).toEqual([1.25, 1.5, 1.25, 1.5]);
  });

  it('a player whose own rate was not 1× before Aloud started', () => {
    const el = video();
    el.playbackRate = 1.25; // the site's saved speed
    document.body.append(el);
    vi.advanceTimersByTime(10);
    el.addEventListener('seeked', () => void (el.playbackRate = 1.25));
    const bar = progressBar();
    bar.addEventListener('click', () => void (el.currentTime = 120));
    const { remembered } = start(2);
    click(bar);
    vi.advanceTimersByTime(2000);
    expect(el.playbackRate).toBe(2);
    expect(remembered).toEqual([2]);
  });

  it('Aloud’s own rewind and skip keys, on a player that resets on `seeking` and `seeked`', () => {
    const el = video();
    document.body.append(el);
    for (const type of ['seeking', 'seeked']) el.addEventListener(type, () => void (el.playbackRate = 1));
    const { remembered } = start(1.5);
    el.currentTime = 200;
    vi.advanceTimersByTime(2000);
    for (const key of ['x', 'z', 'x']) {
      press(key);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
    }
    expect(remembered).toEqual([1.5]);
  });

  describe('a player that reloads the video to move within it', () => {
    it('the same address with a new start time: a remembered speed is kept', () => {
      const el = video('https://cdn.example.org/clip.mp4');
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => el.reload('https://cdn.example.org/clip.mp4?start=120'));
      const { remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('the same address, the rate put back to the default without a `ratechange`', () => {
      const el = video('https://cdn.example.org/clip.mp4');
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => el.reload('https://cdn.example.org/clip.mp4?start=120#t=120', true));
      const { remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('a speed chosen here is kept, whatever the address', () => {
      const el = video('blob:https://site.example/1');
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => el.reload('blob:https://site.example/2'));
      start(null);
      choose(2);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
    });

    // Another address is another video, and it plays at the speed shown, remembered or chosen. A
    // player that reloads through a new `blob:` address on a seek (a media server transcoding
    // from the new position) keeps the speed that way too.
    it('a new address with a remembered speed keeps it, the load resetting it silently', () => {
      const el = video('https://cdn.example.org/one.mp4');
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => el.reload('https://cdn.example.org/two.mp4', true));
      const { remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('a new address with a remembered speed keeps it', () => {
      const el = video('blob:https://site.example/1');
      document.body.append(el);
      const bar = progressBar();
      bar.addEventListener('click', () => el.reload('blob:https://site.example/2'));
      const { remembered } = start(1.5);
      click(bar);
      vi.advanceTimersByTime(2000);
      expect(el.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]); // shown, never stored
    });
  });

  describe('a player that swaps in another <video> to move', () => {
    // A new element is found by a MutationObserver, whose callback is a microtask: these tests
    // let the timers run asynchronously so that it does.
    it('one already loaded at the new position, given the player’s rate a moment later', async () => {
      const first = video();
      document.body.append(first);
      const bar = progressBar();
      bar.addEventListener('click', () => {
        const next = video(); // loaded in the background at the new position
        first.replaceWith(next);
        setTimeout(() => void (next.playbackRate = 1), 50); // its own rate, once it is attached
      });
      const { remembered } = start(1.5);
      click(bar);
      await vi.advanceTimersByTimeAsync(2000);
      const now = document.querySelector('video')!;
      expect(now).not.toBe(first);
      expect(now.playbackRate).toBe(1.5);
      expect(remembered).toEqual([1.5]);
    });

    it('inside the player’s own shadow root, with nothing else on the page changing', async () => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'open' });
      const first = video();
      root.append(first);
      document.body.append(host);
      start(1.5);
      expect(first.playbackRate).toBe(1.5);
      const next = video();
      first.replaceWith(next);
      await vi.advanceTimersByTimeAsync(1000);
      expect(next.playbackRate).toBe(1.5);
    });
  });
});
