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
 */
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

export class TouchSpeedButton {
  private host: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private value: HTMLButtonElement | null = null;
  private open = false;
  private shown = false;
  private timer = 0;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly target: TouchSpeedTarget) {}

  start(): void {
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
    this.render();
    if (!this.place()) {
      this.hide();
      return;
    }
    host.style.display = 'block';
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

  /** At the top-left corner of the video, inside it; false when there is no video to sit on. */
  private place(): boolean {
    const media = this.target.player();
    if (!media || !this.host) return false;
    const box = media.getBoundingClientRect();
    if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT || box.bottom < 40 || box.top > window.innerHeight - 40) return false;
    this.host.style.top = `${Math.max(8, box.top + 10)}px`;
    this.host.style.left = `${Math.max(8, box.left + 10)}px`;
    return true;
  }

  private render(): void {
    if (!this.pill || !this.value) return;
    const rate = formatRate(this.target.rate());
    this.value.textContent = rate;
    this.value.setAttribute('aria-label', this.open ? `${rate}: back to normal speed` : `Video speed ${rate}: change it`);
    this.pill.classList.toggle('open', this.open);
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
        -webkit-tap-highlight-color: transparent; touch-action: manipulation; user-select: none;
      }
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
    // Its taps are its own: a tap on the player is play/pause to most sites.
    for (const type of ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'dblclick']) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    parent.append(host);
    this.host = host;
    this.pill = pill;
    this.value = value;
    return host;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    const options = { capture: true, passive: true } as const;
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }
}
