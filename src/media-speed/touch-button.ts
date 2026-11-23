/**
 * The video speed on a phone: a button on the video, where the keys (S, D, R) do it on a computer.
 *
 * A phone has no keys to press, so the speed control there was out of reach. This puts a small
 * "1.5×" chip at the top-left corner of the video being watched, as a player shows its own
 * controls: when a video starts, and when the video is tapped, fading after a few seconds. Tapped,
 * it opens to "− 1.5× +": a step slower or faster (the step set in Settings), and the number
 * itself back to 1×. It is drawn above a video in full screen too (top-layer.ts).
 *
 * Its taps stay its own: they never reach the page, where a tap on the player pauses the video.
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
}

const HOST_ID = 'aloud-speed-touch';
/** Shown this long after the last touch: the chip, and a little longer once opened. */
const SHOW_MS = 3000;
const OPEN_MS = 5000;
/** Smaller players than this get no button: it would cover them. */
const MIN_WIDTH = 160;
const MIN_HEIGHT = 90;
/** How far a finger must move before a touch is a drag rather than a tap. */
const DRAG_PX = 8;
/** Kept this far inside the video's edges, and the window's. */
const INSET = 10;

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
  private readonly site = location.hostname;

  constructor(private readonly target: TouchSpeedTarget) {}

  start(): void {
    void loadSpot(this.site).then((spot) => {
      if (!spot) return;
      this.spot = spot;
      if (this.shown && !this.place()) this.hide();
    });
    // A tap on the video shows the speed, as it shows the player's own controls; a tap anywhere
    // else closes it. Seen first (capture), and never stopped: the page gets its tap as ever.
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
  }

  /** A video started: show its speed for a moment. */
  wake(): void {
    this.open = false;
    this.show();
  }

  /** The speed changed (a key, the site's own menu): show the new one if the button is up. */
  refresh(): void {
    if (this.shown) this.render();
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
    if (!this.host) return;
    this.host.style.display = 'none';
    lower(this.host);
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), this.open ? OPEN_MS : SHOW_MS);
  }

  /** On the video, where the viewer put it (the top-left corner at first); false when there is no video to sit on. */
  private place(): boolean {
    const box = this.videoBox();
    if (!box || !this.host) return false;
    const at = placeAt(box, this.size(), this.spot, { width: window.innerWidth, height: window.innerHeight });
    this.host.style.left = `${at.left}px`;
    this.host.style.top = `${at.top}px`;
    return true;
  }

  /** The video it sits on, when there is one big enough and on screen. */
  private videoBox(): DOMRect | null {
    const media = this.target.player();
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
      button:active { background: rgba(255, 255, 255, 0.18); }
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
    slower.addEventListener('click', () => this.choose(this.target.stepFrom(this.target.rate(), -1)));
    faster.addEventListener('click', () => this.choose(this.target.stepFrom(this.target.rate(), 1)));
    value.addEventListener('click', () => {
      if (!this.open) {
        this.open = true;
        this.render();
        this.arm();
        return;
      }
      this.choose(1);
    });
    pill.append(slower, value, faster);
    root.append(style, pill);
    this.draggable(pill);
    // Its taps are its own: a tap on the player is play/pause to most sites.
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
   * Moved by dragging it, with a finger or the mouse. A touch that moves less than DRAG_PX is a tap,
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
      this.moveTo(drag.left + dx, drag.top + dy);
      this.arm();
    };
    const end = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moving;
      drag = null;
      for (const type of ['pointermove', 'pointerup', 'pointercancel']) window.removeEventListener(type, type === 'pointermove' ? move : end, true);
      pill.classList.remove('dragging');
      if (!moved) return;
      this.ignoreClicksUntil = performance.now() + 400;
      void saveSpot(this.site, this.spot);
    };
    pill.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !this.host) return;
      const r = this.host.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moving: false };
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
