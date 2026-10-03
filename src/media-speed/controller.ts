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
 *
 * Only a rate you actually asked for here is re-applied like that. A rate that merely came from
 * memory ("this site was last watched at 1.75×") is offered once and then left alone: re-applying
 * it on every `play`/`canplay` meant that dragging Facebook's progress bar — which fires those —
 * silently sped the video up again after the player had reset it to 1×.
 */
import { clampRate, formatRate, nextPreset, stepRate } from './rate';
import { isTypingEvent, matchesBinding } from './keys';
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
  /** Called for each media element as it is found (the autoplay guard); returns its unhook. */
  onMedia?(media: HTMLMediaElement): () => void;
}

type Media = HTMLMediaElement;

export class MediaSpeedController {
  private rate: number | null = null;
  /** True once the rate is a choice made here — by a key, or through the site's own speed menu. */
  private chosen = false;
  /** The rate we set last, to tell our own `ratechange` from the site's. */
  private applied = new WeakMap<Media, number>();
  private readonly known = new Set<Media>();
  /** How to unhook each tracked element, so a removed one can be let go of entirely. */
  private readonly listeners = new Map<Media, () => void>();
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
      if (records.length) {
        this.scan();
        this.prune();
      }
    });
    // `document`, not its root element: started with the page, there may not be one yet.
    this.observer.observe(document, { childList: true, subtree: true });
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent), true);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    for (const release of this.listeners.values()) release();
    this.clearBadge();
    this.known.clear();
    this.listeners.clear();
  }

  setSettings(settings: MediaSpeedSettings): void {
    this.settings = settings;
  }

  /** Media found so far in this frame, not counting ones that have left the page. */
  get mediaCount(): number {
    this.prune();
    return this.known.size;
  }

  get currentRate(): number | null {
    return this.rate;
  }

  /** Set the rate for this frame and show it: a choice, so it is kept through source changes. */
  setRate(rate: number, show = true): void {
    this.chosen = true;
    this.applyRate(rate, show);
  }

  /**
   * The opening rate — remembered for this site, or `startAt`. Applied once to what is here now;
   * the page is free to set its own rate afterwards without this putting it back.
   */
  setInitialRate(rate: number, show = false): void {
    this.applyRate(rate, show);
  }

  private applyRate(rate: number, show: boolean): void {
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
    this.scanFrom(document);
  }

  private scanFrom(root: Element | ShadowRoot | Document): void {
    for (const media of mediaWithin(root)) this.track(media);
  }

  /**
   * Forget players that have left the page.
   *
   * An infinite feed builds and throws away a video per card. Each one used to be kept for ever
   * by the tracking set and by its own listener closures, so a long session accumulated dead
   * players that every later rate change then iterated over.
   */
  private prune(): void {
    for (const media of [...this.known]) {
      if (media.isConnected) continue;
      this.known.delete(media);
      this.listeners.get(media)?.();
      this.listeners.delete(media);
    }
  }

  private track(media: Media): void {
    if (this.known.has(media)) return;
    this.known.add(media);

    // A new source resets the rate to 1; put ours back. `ratechange` tells the site's own speed
    // menu from our own writes, and follows the site when it was not us.
    // Only a chosen rate survives a new source; see the note at the top of the file.
    const reapply = (): void => {
      if (this.chosen) this.apply(media);
    };
    const off: Array<() => void> = [];
    for (const event of ['loadstart', 'loadeddata', 'canplay', 'play', 'playing', 'durationchange']) {
      media.addEventListener(event, reapply);
      off.push(() => media.removeEventListener(event, reapply));
    }
    const onRateChange = (): void => {
      if (this.rate == null) return;
      const ours = this.applied.get(media);
      if (media.playbackRate === ours) return;
      // The site (or the user, through the site's menu) changed it: follow, and match the rest.
      // A change made on a playing video is taken as a choice and kept through the next source;
      // one that arrives while it is still loading or seeking is the player restoring itself.
      if (!media.seeking && media.readyState >= 2) this.chosen = true;
      this.rate = clampRate(media.playbackRate);
      for (const other of this.known) if (other !== media) this.apply(other);
      this.host.onRate(this.rate);
    };

    media.addEventListener('ratechange', onRateChange);
    off.push(() => media.removeEventListener('ratechange', onRateChange));
    const unhook = this.host.onMedia?.(media);
    if (unhook) off.push(unhook);
    const release = (): void => {
      for (const un of off) un();
    };
    // Only in `listeners`: `prune` deletes it there, and with it the last reference to the element.
    // Kept in `cleanups` as well, a removed player stayed reachable until the control stopped.
    this.listeners.set(media, release);

    if (this.rate == null && this.host.initialRate != null) {
      this.rate = clampRate(this.host.initialRate);
    }
    this.apply(media);
  }

  // ---- keys -------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (!this.settings.enabled || e.defaultPrevented || isTypingEvent(e)) return;
    // Aloud's reading bar handles its own keys.
    if (e.composedPath().some((n) => n instanceof HTMLElement && n.id === CONTROL_HOST_ID)) return;

    const { keys } = this.settings;
    const seek = matchesBinding(e, keys.rewind) ? -1 : matchesBinding(e, keys.advance) ? 1 : 0;
    if (seek) {
      e.preventDefault();
      e.stopPropagation();
      this.seekBy(seek * (this.settings.seekSeconds || 10));
      return;
    }
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

  // ---- seeking --------------------------------------------------------------------------

  /**
   * Move the video you are watching by `seconds`, and say where it is now.
   *
   * For players that offer no way back at all: YouTube Shorts has no rewind key and, on most
   * Shorts, no seek bar, so a missed sentence meant watching the whole thing again.
   */
  seekBy(seconds: number): void {
    this.prune();
    const media = activeMedia(this.known);
    if (!media) {
      this.showBadge('No video or audio here', undefined, true);
      return;
    }
    const duration = Number.isFinite(media.duration) ? media.duration : null;
    const target = Math.max(0, duration != null ? Math.min(duration - 0.1, media.currentTime + seconds) : media.currentTime + seconds);
    try {
      media.currentTime = target;
    } catch {
      return; // a live stream with nothing to seek into
    }
    const where = duration != null ? `${clock(target)} / ${clock(duration)}` : clock(target);
    this.showBadge(`${seconds < 0 ? '−' : '+'}${Math.abs(seconds)} s · ${where}`, media);
  }

  // ---- the badge ----------------------------------------------------------------------

  /**
   * Say something over `media` whatever the badge setting — it is not about the speed, and a video
   * that stopped by itself with no word why looks broken. Once every few seconds at most, for sites
   * that keep calling play.
   */
  notice(text: string, media?: Media): void {
    const now = Date.now();
    if (now - this.lastNotice < 4000) return;
    this.lastNotice = now;
    this.showBadge(text, media, true);
  }
  private lastNotice = 0;

  /**
   * The speed, over the largest video on screen (or at the corner of the window when the media
   * has no box of its own, as audio does not). Its own closed shadow root, so nothing of the
   * page's styling reaches it and nothing of ours reaches the page.
   */
  private showBadge(text: string, over?: Media, always = false): void {
    if (!this.settings.showBadge && !always) return;
    const badge = this.badge ?? this.createBadge();
    if (!badge) return;
    badge.text.textContent = text;
    const box = (over && largestBox([over])) ?? largestBox(this.known);
    const top = box ? Math.max(8, box.top + 12) : 16;
    const left = box ? Math.max(8, box.left + 12) : 16;
    badge.host.style.top = `${top}px`;
    badge.host.style.left = `${left}px`;
    badge.host.style.display = 'block';
    clearTimeout(badge.timer);
    badge.timer = window.setTimeout(() => {
      if (this.badge) this.badge.host.style.display = 'none';
    }, always ? BADGE_MS * 2 : BADGE_MS);
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

/**
 * The player the reader means: the one playing (the largest, if several), else the largest on
 * screen. Shorts keeps the next and previous clips loaded and paused beside the one you watch.
 */
function activeMedia(media: Iterable<Media>): Media | null {
  let best: Media | null = null;
  let bestScore = -1;
  for (const el of media) {
    const box = el.getBoundingClientRect();
    const onScreen = box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
    const area = onScreen ? box.width * box.height : 0;
    // Playing outranks everything; then size on screen. Audio (no box) still counts if it plays.
    const score = (el.paused ? 0 : 1e9) + area + (onScreen ? 1 : 0);
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/** 83 → "1:23"; 3723 → "1:02:03". */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
