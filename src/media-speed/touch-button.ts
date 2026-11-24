/**
 * The video speed as a button on the video. On a phone it is the only way to change the speed, as
 * a phone has no keys to press; on a computer it sits beside the keys (S, D, R), for whoever would
 * rather click (Settings: "Show a speed button on videos").
 *
 * A small "1.5×" chip at the top-left corner of the video being watched, shown as a player shows
 * its own controls: when a video starts, when the video is tapped or clicked, and on a computer
 * while the mouse moves over it, fading after a few seconds of stillness (not while the mouse is
 * on the chip itself). Tapped or clicked, it opens to "− 1.5× +": a step slower or faster (the
 * step set in Settings), and the number itself back to 1×. It is drawn above a video in full
 * screen too (top-layer.ts), and never over Aloud's own reading bar.
 *
 * Its taps and clicks stay its own: they never reach the page, where a click on the player pauses
 * the video. Nor does it take the page's keys: a click leaves the focus where it was, so Space
 * still pauses the video instead of pressing the button again.
 *
 * It can be moved: dragged with a finger or the mouse anywhere on the video, off whatever of the
 * player's own it covered (a back button, a title, the site's menu), and it stays there, on that
 * site, from then on. Where it sits is kept as a fraction of the video, so it follows the video
 * when it is resized, turned or put in full screen.
 */
import { storage } from 'wxt/utils/storage';
import { withStorageLock } from '@/shared/storage-lock';
import { formatRate } from './rate';
import { TOP_LAYER_HOST_STYLE, lower, raise, topLayerHost } from './top-layer';

export interface TouchSpeedTarget {
  /** The speed now. */
  rate(): number;
  /** Set the speed, as the viewer's choice. */
  setRate(rate: number): void;
  /** The speed a step from `rate`, slower (-1) or faster (+1). */
  stepFrom(rate: number, direction: 1 | -1): number;
  /** The player the viewer means, if one is on screen. */
  player(): HTMLMediaElement | null;
  /**
   * The video under the mouse: the largest one big enough for the button there. The player the
   * viewer "means" is the one playing, which on a computer is not the one the mouse is on: a paused
   * film got no button while a small preview playing elsewhere did.
   */
  playerAt(x: number, y: number): HTMLMediaElement | null;
}

const HOST_ID = 'aloud-speed-touch';
/** Aloud's reading bar (ui/control-bar.ts): the button is kept off it. */
const READER_HOST_ID = 'aloud-control-host';
/** Shown this long after the last touch or mouse move: the chip, and a little longer once opened. */
const SHOW_MS = 3000;
const OPEN_MS = 5000;
/** Smaller players than this get no button: it would cover them. */
const MIN_WIDTH = 160;
const MIN_HEIGHT = 90;
/** How far a finger or the mouse must move before a press is a drag rather than a tap. */
const DRAG_PX = 8;
/** Kept this far inside the video's edges, and the window's. */
const INSET = 10;
/** The mouse moving over a video is looked at this often, at most. */
const HOVER_MS = 200;
/** Kept this far clear of the reading bar, and moved off it in steps this big. */
const BAR_GAP = 6;
const BAR_STEP = 12;

/** Where the button sits on the video: 0 is its left (top) edge, 1 its right (bottom). */
export interface TouchSpot {
  x: number;
  y: number;
}
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Size {
  width: number;
  height: number;
}

/** Where a button of `size` goes at `spot` on the video `box`, kept inside it and the window. */
export function placeAt(box: Box, size: Size, spot: TouchSpot, view: Size): { left: number; top: number } {
  const inner = { left: box.left + INSET, top: box.top + INSET, width: box.width - 2 * INSET, height: box.height - 2 * INSET };
  const left = inner.left + clamp01(spot.x) * Math.max(0, inner.width - size.width);
  const top = inner.top + clamp01(spot.y) * Math.max(0, inner.height - size.height);
  return {
    left: Math.round(clampTo(left, 8, view.width - size.width - 8)),
    top: Math.round(clampTo(top, 8, view.height - size.height - 8)),
  };
}

/** The spot a button of `size` at (`left`, `top`) is at on the video `box`. */
export function spotAt(box: Box, size: Size, left: number, top: number): TouchSpot {
  const width = box.width - 2 * INSET - size.width;
  const height = box.height - 2 * INSET - size.height;
  return {
    x: width > 0 ? clamp01((left - box.left - INSET) / width) : 0,
    y: height > 0 ? clamp01((top - box.top - INSET) / height) : 0,
  };
}

/**
 * The top nearest `top`, between `min` and `max`, at which `blocked` says nothing is in the way:
 * looked for a `step` at a time, upwards first (the reading bar sits at the bottom of the window),
 * then downwards, the ends of the range included. Null when the whole range is blocked.
 */
export function nearestClear(top: number, min: number, max: number, step: number, blocked: (top: number) => boolean): number | null {
  if (!blocked(top)) return top;
  if (!(step > 0) || !(max >= min)) return null;
  const up: number[] = [];
  const down: number[] = [];
  for (let t = top - step; t > min; t -= step) up.push(t);
  if (top > min) up.push(min);
  for (let t = top + step; t < max; t += step) down.push(t);
  if (top < max) down.push(max);
  for (let i = 0; i < Math.max(up.length, down.length); i++) {
    if (i < up.length && !blocked(up[i]!)) return up[i]!;
    if (i < down.length && !blocked(down[i]!)) return down[i]!;
  }
  return null;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const clampTo = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(Math.max(lo, hi), n));

/** Where the button was moved to, by site: never synced, like the speed each site was watched at. */
type TouchSpots = Record<string, TouchSpot & { at: number }>;
const MAX_SPOTS = 200;
const spots = storage.defineItem<TouchSpots>('local:mediaSpeedTouchSpots', { fallback: {} });

async function loadSpot(site: string): Promise<TouchSpot | null> {
  try {
    const spot = (await spots.getValue())?.[site];
    return spot && Number.isFinite(spot.x) && Number.isFinite(spot.y) ? { x: clamp01(spot.x), y: clamp01(spot.y) } : null;
  } catch {
    return null;
  }
}

/** Forget where the button was moved, on every site (Settings: "Forget remembered site speeds"). */
export async function clearTouchSpots(): Promise<void> {
  await withStorageLock('touch-spots', () => spots.setValue({}));
}

async function saveSpot(site: string, spot: TouchSpot): Promise<void> {
  try {
    await withStorageLock('touch-spots', async () => {
      const all = { ...((await spots.getValue()) ?? {}), [site]: { ...spot, at: Date.now() } };
      const sites = Object.keys(all);
      if (sites.length > MAX_SPOTS) {
        for (const old of sites.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, sites.length - MAX_SPOTS)) delete all[old];
      }
      await spots.setValue(all);
    });
  } catch {
    /* best-effort: it goes back to the corner next time */
  }
}

export class TouchSpeedButton {
  private host: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private value: HTMLButtonElement | null = null;
  private open = false;
  private shown = false;
  private timer = 0;
  private readonly cleanups: Array<() => void> = [];
  /** Where the viewer moved it on this site; the top-left corner until they do. */
  private spot: TouchSpot = { x: 0, y: 0 };
  /** A drag ends in a click on whatever it ended over: not a tap, so not acted on. */
  private ignoreClicksUntil = 0;
  /** A finger or the mouse is down on it, or the mouse is over it: it stays up until it is not. */
  private pressed = false;
  private hovered = false;
  /** When the mouse moving over the page was last looked at (HOVER_MS). */
  private lastHover = -Infinity;
  /** The video it was shown for (under the mouse, or the one that started): where it sits. */
  private media: HTMLMediaElement | null = null;
  /** The keyboard is in it: it stays up, or the focus fell to the page as it faded. */
  private focused = false;
  /** When it last opened to "− 1× +": the second click of a double-click is not a press of "−". */
  private openedAt = -Infinity;
  private readonly site = location.hostname;

  constructor(private readonly target: TouchSpeedTarget) {}

  start(): void {
    void loadSpot(this.site).then((spot) => {
      if (!spot) return;
      this.spot = spot;
      if (this.shown && !this.place()) this.hide();
    });
    // A tap or click on the video shows the speed, as it shows the player's own controls; one
    // anywhere else closes it. Seen first (capture), and never stopped: the page gets it as ever.
    this.listen(window, 'pointerdown', (e) => {
      const event = e as PointerEvent;
      if (this.host && event.composedPath().includes(this.host)) return;
      const media = this.target.player();
      const box = media?.getBoundingClientRect();
      if (box && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
        this.open = false;
        this.show();
      } else if (this.shown) {
        this.hide();
      }
    });
    // On a computer the mouse moving over the video shows it too, as it shows the player's own
    // controls, and keeps it up while it moves. Only looked at a few times a second, since finding
    // the video measures every player on the page; but the last move is always looked at, or a
    // mouse that came onto the video and stopped there at once showed nothing.
    const hoverAt = (x: number, y: number): void => {
      this.lastHover = performance.now();
      const media = this.target.playerAt(x, y);
      if (!media) return;
      const moved = media !== this.media;
      this.media = media;
      if (this.shown && !moved) {
        // Placed again, not only kept up: a reading bar that appeared or slid back since it was
        // placed would otherwise stay under it, its clicks caught by the button.
        if (this.place()) this.arm();
        else this.hide();
      } else {
        this.open = false;
        this.show();
      }
    };
    let last = { x: 0, y: 0 };
    let later = 0;
    this.listen(window, 'pointermove', (e) => {
      const event = e as PointerEvent;
      if (event.pointerType === 'touch') return;
      // Over the button itself: `hovered` holds it up (see create).
      if (this.host && event.composedPath().includes(this.host)) return;
      last = { x: event.clientX, y: event.clientY };
      const wait = this.lastHover + HOVER_MS - performance.now();
      if (wait <= 0) {
        hoverAt(last.x, last.y);
      } else if (!later) {
        later = window.setTimeout(() => {
          later = 0;
          hoverAt(last.x, last.y);
        }, wait);
      }
    });
    this.cleanups.push(() => clearTimeout(later));
    // Kept on the video while the page scrolls or turns, and over it in full screen.
    const follow = (): void => {
      if (this.shown && !this.place()) this.hide();
    };
    this.listen(window, 'scroll', follow);
    this.listen(window, 'resize', follow);
    this.listen(document, 'fullscreenchange', () => {
      if (this.shown) this.show();
    });
  }

  stop(): void {
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    clearTimeout(this.timer);
    this.host?.remove();
    this.host = null;
    this.shown = false;
  }

  /** A video started: show its speed for a moment, on that video. */
  wake(media?: HTMLMediaElement): void {
    this.media = media ?? null;
    this.open = false;
    this.show();
  }

  /** The speed changed (a key, the site's own menu): show the new one if the button is up. */
  refresh(): void {
    if (this.shown) this.render();
  }

  /** Where it is on screen, while it is up: the badge keeps out from under it. */
  onScreen(): DOMRect | null {
    return this.shown && this.host ? this.host.getBoundingClientRect() : null;
  }

  private show(): void {
    const host = this.host ?? this.create();
    if (!host) return;
    // Shown before it is placed: its size decides where it fits.
    host.style.display = 'block';
    this.render();
    if (!this.place()) {
      this.hide();
      return;
    }
    raise(host);
    this.shown = true;
    this.arm();
  }

  private hide(): void {
    clearTimeout(this.timer);
    this.open = false;
    this.shown = false;
    // Hidden from under a still mouse, it is told of no leaving: shown again, it would never fade.
    this.hovered = false;
    if (!this.host) return;
    this.host.style.display = 'none';
    lower(this.host);
  }

  private arm(): void {
    clearTimeout(this.timer);
    // Its few seconds start once it is let go of, or the mouse or the keyboard leaves it.
    if (this.pressed || this.hovered || this.focused) return;
    this.timer = window.setTimeout(() => this.hide(), this.open ? OPEN_MS : SHOW_MS);
  }

  /**
   * On the video, where the viewer put it (the top-left corner at first), and up or down off the
   * reading bar when that is in the way; false when there is no video to sit on, or no room on it.
   */
  private place(): boolean {
    const box = this.videoBox();
    if (!box || !this.host) return false;
    const size = this.size();
    const view = { width: window.innerWidth, height: window.innerHeight };
    const at = placeAt(box, size, this.spot, view);
    const bar = this.readingBar();
    if (bar) {
      const min = Math.max(8, box.top + INSET);
      const max = Math.min(view.height - size.height - 8, box.bottom - INSET - size.height);
      const top = nearestClear(at.top, min, Math.max(min, max), BAR_STEP, (t) => this.onBar(bar, at.left, t, size));
      if (top == null) return false;
      at.top = Math.round(top);
    }
    this.host.style.left = `${at.left}px`;
    this.host.style.top = `${at.top}px`;
    return true;
  }

  /**
   * Aloud's reading bar, when it is on this page and can be in the way. Not in full screen: the
   * browser draws only the full-screen element then, and the bar, though hidden, is still in place.
   */
  private readingBar(): Element | null {
    if (typeof document.elementsFromPoint !== 'function') return null;
    const bar = document.getElementById(READER_HOST_ID);
    if (!bar) return null;
    const full = document.fullscreenElement;
    return full && !full.contains(bar) ? null : bar;
  }

  /**
   * Would the button, at (`left`, `top`), cover any of the reading bar? The bar's box is in a
   * closed shadow root, out of reach, so the window is asked what is under the button's corners,
   * edges and middle. A bar slid away or hidden takes no pointer, so it is not found there.
   */
  private onBar(bar: Element, left: number, top: number, size: Size): boolean {
    const x0 = left - BAR_GAP;
    const y0 = top - BAR_GAP;
    const x1 = left + size.width + BAR_GAP;
    const y1 = top + size.height + BAR_GAP;
    const xm = (x0 + x1) / 2;
    const ym = (y0 + y1) / 2;
    const points: Array<[number, number]> = [[x0, y0], [xm, y0], [x1, y0], [x0, ym], [xm, ym], [x1, ym], [x0, y1], [xm, y1], [x1, y1]];
    return points.some(([x, y]) => document.elementsFromPoint(x, y).includes(bar));
  }

  /** The video it sits on, when there is one big enough and on screen. */
  private videoBox(): DOMRect | null {
    const media = (this.media?.isConnected ? this.media : null) ?? this.target.player();
    if (!media) return null;
    const box = media.getBoundingClientRect();
    if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT || box.bottom < 40 || box.top > window.innerHeight - 40) return null;
    return box;
  }

  private size(): Size {
    const r = this.host?.getBoundingClientRect();
    return { width: r?.width ?? 0, height: r?.height ?? 0 };
  }

  /** Dragged to (`left`, `top`): there, kept on the video, and remembered as a spot on it. */
  private moveTo(left: number, top: number): void {
    const box = this.videoBox();
    if (!box || !this.host) return;
    this.spot = spotAt(box, this.size(), left, top);
    this.place();
  }

  private render(): void {
    if (!this.pill || !this.value) return;
    const rate = formatRate(this.target.rate());
    this.value.textContent = rate;
    this.value.setAttribute('aria-label', this.open ? `${rate}: back to normal speed` : `Video speed ${rate}: change it`);
    this.pill.classList.toggle('open', this.open);
    // Opened, it is wider: still on the video, near a right-hand edge too.
    if (this.shown) this.place();
  }

  private choose(rate: number): void {
    this.target.setRate(rate);
    this.render();
    this.arm();
  }

  private create(): HTMLElement | null {
    const parent = document.body ?? document.documentElement;
    if (!parent) return null;
    const host = document.createElement('div');
    host.id = HOST_ID;
    topLayerHost(host);
    host.style.cssText = `${TOP_LAYER_HOST_STYLE}pointer-events:auto;`;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .pill {
        display: flex; align-items: center; gap: 2px; padding: 3px;
        font: 600 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #fff; background: rgba(20, 20, 24, 0.82); border-radius: 12px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
        /* A finger on it moves it, not the page. */
        touch-action: none; cursor: grab;
      }
      .pill.dragging { cursor: grabbing; opacity: 0.85; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); }
      button {
        all: unset; box-sizing: border-box; min-width: 44px; min-height: 40px; padding: 0 12px;
        display: inline-flex; align-items: center; justify-content: center; border-radius: 9px;
        cursor: pointer; font: inherit; color: inherit;
      }
      /* The mouse over a button lights it, as a player's own buttons do; not a finger, where it sticks. */
      @media (hover: hover) {
        button:hover { background: rgba(255, 255, 255, 0.12); }
        .pill.dragging button:hover { background: none; }
      }
      button:active, button.down { background: rgba(255, 255, 255, 0.18); }
      button:focus-visible { outline: 2px solid #ffd60a; outline-offset: 1px; }
      .step { font-size: 22px; font-weight: 500; }
      .pill:not(.open) .step { display: none; }
      .value { min-width: 56px; }`;
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.setAttribute('role', 'group');
    pill.setAttribute('aria-label', 'Video speed');
    const button = (cls: string, text: string, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      if (label) b.setAttribute('aria-label', label);
      return b;
    };
    const slower = button('step', '−', 'Slower');
    const value = button('value', '1×', '');
    const faster = button('step', '+', 'Faster');
    // A double-click on "1×" opened it with the first click and pressed what then lay under the
    // pointer with the second ("−", or "1×" again): the speed changed with no one asking.
    const secondOfDouble = (e: MouseEvent): boolean => e.detail > 1 && performance.now() - this.openedAt < 500;
    slower.addEventListener('click', (e) => {
      if (!secondOfDouble(e)) this.choose(this.target.stepFrom(this.target.rate(), -1));
    });
    faster.addEventListener('click', (e) => {
      if (!secondOfDouble(e)) this.choose(this.target.stepFrom(this.target.rate(), 1));
    });
    value.addEventListener('click', (e) => {
      if (!this.open) {
        this.open = true;
        this.openedAt = performance.now();
        this.render();
        this.arm();
        return;
      }
      if (!secondOfDouble(e)) this.choose(1);
    });
    // Pressed, drawn pressed. `:active` is not: the mousedown below is cancelled (to keep the
    // focus off it), and Firefox then never marks the button active.
    for (const b of [slower, value, faster]) {
      b.addEventListener('pointerdown', () => b.classList.add('down'));
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(type, () => b.classList.remove('down'));
    }
    pill.append(slower, value, faster);
    root.append(style, pill);
    this.draggable(pill);
    // Held up while the mouse is on it, to be read or clicked at leisure. Not for a finger, whose
    // press already holds it (see draggable) and which "leaves" only as it lifts.
    pill.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      this.hovered = true;
      clearTimeout(this.timer);
    });
    pill.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch' || !this.hovered) return;
      this.hovered = false;
      if (this.shown) this.arm();
    });
    // Held up while the keyboard is in it (Tab reaches it while it shows): faded with the focus
    // inside, it dropped the focus to the page, and the reader lost their place in it.
    pill.addEventListener('focusin', () => {
      this.focused = true;
      clearTimeout(this.timer);
    });
    pill.addEventListener('focusout', () => {
      this.focused = false;
      if (this.shown) this.arm();
    });
    // A click leaves the focus where it was. Left on the button, the page's Space (pause) and
    // Enter pressed it again, and the speed changed instead of the video pausing.
    pill.addEventListener('mousedown', (e) => e.preventDefault());
    // Its taps and clicks are its own: one on the player is play/pause to most sites.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'dblclick']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    parent.append(host);
    this.host = host;
    this.pill = pill;
    this.value = value;
    return host;
  }

  /**
   * Moved by dragging it, with a finger or the mouse. A press that moves less than DRAG_PX is a tap,
   * left to the buttons; past that it is a drag, and the click it ends in is not acted on.
   */
  private draggable(pill: HTMLElement): void {
    let drag: { id: number; x: number; y: number; left: number; top: number; moving: boolean } | null = null;
    // Followed on the whole window from the press: a quick flick's first move is already off the
    // button, and the button alone never heard it, so the drag was lost.
    const move = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moving) {
        if (Math.hypot(dx, dy) < DRAG_PX) return;
        drag.moving = true;
        pill.classList.add('dragging');
        // Only now: captured from the press, a plain tap's click went to the pill, not its button.
        try {
          pill.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
      }
      // No timer while it is held (see pointerdown): a drag that pauses keeps it on screen.
      this.moveTo(drag.left + dx, drag.top + dy);
    };
    const end = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moving;
      drag = null;
      this.pressed = false;
      for (const type of ['pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(type, type === 'pointermove' ? move : end, true);
      pill.classList.remove('dragging');
      // Its few seconds start again from the release (they were held while the finger was on it).
      this.arm();
      if (!moved) return;
      this.ignoreClicksUntil = performance.now() + 400;
      void saveSpot(this.site, this.spot);
    };
    pill.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !this.host) return;
      const r = this.host.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moving: false };
      // Not hidden under the finger: a press held still, as one does to pick an icon up on a phone,
      // outlasted the few seconds it shows for, and it vanished mid-drag. Held, too, against the
      // mouse moving over the video, which would start them again (arm).
      this.pressed = true;
      clearTimeout(this.timer);
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
    });
    this.cleanups.push(() => {
      for (const type of ['pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(type, type === 'pointermove' ? move : end, true);
    });
    // Before the buttons hear it.
    pill.addEventListener(
      'click',
      (e) => {
        if (performance.now() >= this.ignoreClicksUntil) return;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    const options = { capture: true, passive: true } as const;
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }
}
