/**
 * The media speed control, as it runs inside a page.
 *
 * It sets `playbackRate` on every `<video>` and `<audio>` in the frame, including ones inside
 * open shadow roots and ones added later, and puts the new speed briefly on screen. Sites that
 * swap the video for the next one (YouTube between videos, any player after an ad) reset the
 * rate to 1 on the new source, so the chosen rate is re-applied whenever a media element loads.
 *
 * A rate changed by the *site's own* speed menu is respected and becomes the current rate — the
 * alternative is two controls fighting over one video, which no one wins.
 */
import { clampRate, formatRate, nextPreset, stepRate } from './rate';
import { isTypingTarget, matchesBinding } from './keys';
import type { MediaSpeedSettings } from '@/shared/settings';

/** Aloud's own reading bar: its keys are its own (see ui/control-bar.ts). */
const CONTROL_HOST_ID = 'aloud-control-host';
const BADGE_HOST_ID = 'aloud-speed-badge';
const BADGE_MS = 1400;

export interface ControllerHost {
  settings: MediaSpeedSettings;
  /** Rate to start from: the site's remembered rate, `startAt`, or null to leave media alone. */
  initialRate: number | null;
  /** Called when the rate changes, so it can be remembered for this site. */
  onRate(rate: number): void;
}

type Media = HTMLMediaElement;

export class MediaSpeedController {
  private rate: number | null = null;
  /** The rate we set last, to tell our own `ratechange` from the site's. */
  private applied = new WeakMap<Media, number>();
  private readonly known = new Set<Media>();
  private observer: MutationObserver | null = null;
  private badge: { host: HTMLElement; text: HTMLElement; timer: number } | null = null;
  private readonly cleanups: Array<() => void> = [];
  private settings: MediaSpeedSettings;

  constructor(private readonly host: ControllerHost) {
    this.settings = host.settings;
  }

  start(): void {
    this.scan();
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) this.scanFrom(node);
      }
      // A node moved into an existing player is just as common as a fresh one.
      if (records.length) this.scan();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent), true);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    this.clearBadge();
    this.known.clear();
  }

  setSettings(settings: MediaSpeedSettings): void {
    this.settings = settings;
  }

  /** Media found so far in this frame. */
  get mediaCount(): number {
    return this.known.size;
  }

  get currentRate(): number | null {
    return this.rate;
  }

  /** Set the rate for this frame and show it. `show: false` for the silent opening rate. */
  setRate(rate: number, show = true): void {
    this.rate = clampRate(rate);
    for (const media of this.known) this.apply(media);
    if (show) this.showBadge(formatRate(this.rate));
    this.host.onRate(this.rate);
  }

  private apply(media: Media): void {
    if (this.rate == null) return;
    try {
      this.applied.set(media, this.rate);
      if (media.playbackRate !== this.rate) media.playbackRate = this.rate;
    } catch {
      // Some players throw on a rate they consider out of range; the others still get it.
    }
  }

  // ---- finding media ---------------------------------------------------------------

  private scan(): void {
    this.scanFrom(document.documentElement);
  }

  private scanFrom(root: Element | ShadowRoot): void {
    for (const media of mediaWithin(root)) this.track(media);
  }

  private track(media: Media): void {
    if (this.known.has(media)) return;
    this.known.add(media);

    // A new source resets the rate to 1; put ours back. `ratechange` tells the site's own speed
    // menu from our own writes, and follows the site when it was not us.
    const reapply = (): void => this.apply(media);
    for (const event of ['loadstart', 'loadeddata', 'canplay', 'play', 'playing', 'durationchange']) {
      media.addEventListener(event, reapply);
      this.cleanups.push(() => media.removeEventListener(event, reapply));
    }
    const onRateChange = (): void => {
      if (this.rate == null) return;
      const ours = this.applied.get(media);
      if (media.playbackRate === ours) return;
      // The site (or the user, through the site's menu) changed it: follow, and match the rest.
      this.rate = clampRate(media.playbackRate);
      for (const other of this.known) if (other !== media) this.apply(other);
      this.host.onRate(this.rate);
    };
    media.addEventListener('ratechange', onRateChange);
    this.cleanups.push(() => media.removeEventListener('ratechange', onRateChange));

    if (this.rate == null && this.host.initialRate != null) {
      this.rate = clampRate(this.host.initialRate);
    }
    this.apply(media);
  }

  // ---- keys -------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (!this.settings.enabled || e.defaultPrevented || isTypingTarget(e.target)) return;
    // Aloud's reading bar handles its own keys.
    if (e.composedPath().some((n) => n instanceof HTMLElement && n.id === CONTROL_HOST_ID)) return;

    const { keys } = this.settings;
    const current = this.rate ?? currentRateOf(this.known) ?? 1;
    let next: number | null = null;
    if (matchesBinding(e, keys.faster)) next = stepRate(current, this.settings.step, 1);
    else if (matchesBinding(e, keys.slower)) next = stepRate(current, this.settings.step, -1);
    else if (matchesBinding(e, keys.reset)) next = 1;
    else if (matchesBinding(e, keys.preferred)) next = current === this.settings.preferred ? 1 : this.settings.preferred;
    else if (matchesBinding(e, keys.nextPreset)) next = nextPreset(current, this.settings.presets, 1);
    else if (matchesBinding(e, keys.previousPreset)) next = nextPreset(current, this.settings.presets, -1);
    if (next == null) return;

    e.preventDefault();
    e.stopPropagation();
    if (this.known.size === 0) {
      this.showBadge('No video or audio here');
      return;
    }
    this.setRate(next);
  }

  // ---- the badge ----------------------------------------------------------------------

  /**
   * The speed, over the largest video on screen (or at the corner of the window when the media
   * has no box of its own, as audio does not). Its own closed shadow root, so nothing of the
   * page's styling reaches it and nothing of ours reaches the page.
   */
  private showBadge(text: string): void {
    if (!this.settings.showBadge) return;
    const badge = this.badge ?? this.createBadge();
    if (!badge) return;
    badge.text.textContent = text;
    const box = largestBox(this.known);
    const top = box ? Math.max(8, box.top + 12) : 16;
    const left = box ? Math.max(8, box.left + 12) : 16;
    badge.host.style.top = `${top}px`;
    badge.host.style.left = `${left}px`;
    badge.host.style.display = 'block';
    clearTimeout(badge.timer);
    badge.timer = window.setTimeout(() => {
      if (this.badge) this.badge.host.style.display = 'none';
    }, BADGE_MS);
  }

  private createBadge(): { host: HTMLElement; text: HTMLElement; timer: number } | null {
    const parent = document.body ?? document.documentElement;
    if (!parent) return null;
    const host = document.createElement('div');
    host.id = BADGE_HOST_ID;
    host.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .chip {
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #fff; background: rgba(20, 20, 24, 0.82);
        padding: 6px 10px; border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(3px);
      }`;
    const chip = document.createElement('div');
    chip.className = 'chip';
    root.append(style, chip);
    parent.append(host);
    this.cleanups.push(() => host.remove());
    this.badge = { host, text: chip, timer: 0 };
    return this.badge;
  }

  private clearBadge(): void {
    if (!this.badge) return;
    clearTimeout(this.badge.timer);
    this.badge.host.remove();
    this.badge = null;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }
}

/** Every `<video>`/`<audio>` under `root`, following open shadow roots. */
function mediaWithin(root: Element | ShadowRoot | Document): Media[] {
  const found: Media[] = [];
  const visit = (node: Element | ShadowRoot | Document): void => {
    if (node instanceof HTMLMediaElement) found.push(node);
    for (const el of node.querySelectorAll('video, audio')) found.push(el as Media);
    // Shadow DOM: players on many sites live inside one.
    for (const el of node.querySelectorAll('*')) {
      const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) visit(shadow);
    }
  };
  visit(root);
  return found;
}

function currentRateOf(media: Iterable<Media>): number | null {
  for (const el of media) return el.playbackRate;
  return null;
}

/** The on-screen box of the biggest visible media element, for placing the badge. */
function largestBox(media: Iterable<Media>): DOMRect | null {
  let best: DOMRect | null = null;
  for (const el of media) {
    const box = el.getBoundingClientRect();
    if (box.width < 40 || box.height < 30) continue;
    if (box.bottom < 0 || box.top > window.innerHeight) continue;
    if (!best || box.width * box.height > best.width * best.height) best = box;
  }
  return best;
}
