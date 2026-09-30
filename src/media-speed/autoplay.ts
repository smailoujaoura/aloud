/**
 * Stop videos and audio that start by themselves.
 *
 * Part of the speed control, so it runs only where the speed control already runs (the sites you
 * gave it) and asks for nothing new. A content script cannot stop the page calling `play()` — it
 * lives in its own JavaScript world — but it sees the `play` that follows, and pauses at once.
 *
 * What counts as asked for:
 *
 * - **You did something** in the last few seconds: a click, a tap, a key (Space on YouTube). That
 *   also covers clicking a video in a single-page site, where the player starts a moment later.
 * - **Playback carrying on**: something was playing a moment ago and the site swapped the source —
 *   an ad handing over to the video you started. Without this, the video you pressed play on
 *   would stop dead after its ad.
 *
 * Everything else — a video playing as the page opens, the next one in a feed, a preview on hover —
 * is paused, and says so on the video.
 */

/** How long after a click or key press a `play` is taken as yours. */
export const GESTURE_MS = 5000;
/** How soon after something stopped playing a new `play` is taken as the same playback carrying on. */
export const HANDOVER_MS = 2000;

type Media = HTMLMediaElement;

export interface AutoplayGuardOptions {
  enabled: boolean;
  /**
   * Leave alone what is already playing when the guard starts. True when the control was started
   * by its shortcut on a page you are already watching; false when it came with the page.
   */
  leavePlaying: boolean;
  /** Tell the reader a video was stopped (shown over it). */
  notice(media: Media): void;
  now?: () => number;
  /** Whether the frame has transient user activation, where the browser says. */
  activated?: () => boolean;
}

export class AutoplayGuard {
  enabled: boolean;
  private leavePlaying: boolean;
  private lastGesture = Number.NEGATIVE_INFINITY;
  private lastStop = Number.NEGATIVE_INFINITY;
  /** Media playing right now, so a stop can be told from a source that never played. */
  private readonly playing = new WeakSet<Media>();
  /** Media this guard paused, so its own pause is not taken as playback ending. */
  private readonly paused = new WeakSet<Media>();
  private readonly now: () => number;
  private readonly activated: () => boolean;

  constructor(private readonly opts: AutoplayGuardOptions) {
    this.enabled = opts.enabled;
    this.leavePlaying = opts.leavePlaying;
    this.now = opts.now ?? (() => performance.now());
    this.activated =
      opts.activated ??
      (() => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === true);
  }

  /** Listen for the reader's clicks and keys. Call as early as possible; returns the unhook. */
  watchGestures(target: EventTarget = window): () => void {
    const mark = (e: Event): void => {
      if (e.isTrusted) this.lastGesture = this.now();
    };
    const types = ['pointerdown', 'keydown', 'touchstart'];
    for (const type of types) target.addEventListener(type, mark, true);
    return () => {
      for (const type of types) target.removeEventListener(type, mark, true);
    };
  }

  /** The first look at the page is done: from here on, anything found playing is checked. */
  settle(): void {
    this.leavePlaying = false;
  }

  /** Follow one media element. Returns the unhook. */
  track(media: Media): () => void {
    const onPlay = (): void => this.onPlay(media);
    const onPlaying = (): void => {
      if (!this.paused.has(media)) this.playing.add(media);
    };
    const onStop = (): void => {
      if (this.paused.delete(media)) return;
      if (this.playing.delete(media)) this.lastStop = this.now();
    };
    const events: Array<[string, () => void]> = [
      ['play', onPlay],
      ['playing', onPlaying],
      ['pause', onStop],
      ['ended', onStop],
      ['emptied', onStop],
    ];
    for (const [type, fn] of events) media.addEventListener(type, fn);

    if (!media.paused) {
      if (this.leavePlaying) this.playing.add(media);
      else this.onPlay(media);
    }
    return () => {
      for (const [type, fn] of events) media.removeEventListener(type, fn);
    };
  }

  /** Whether a `play` right now was asked for. */
  allows(): boolean {
    const now = this.now();
    return now - this.lastGesture <= GESTURE_MS || now - this.lastStop <= HANDOVER_MS || this.activated();
  }

  private onPlay(media: Media): void {
    if (!this.enabled || this.allows()) return;
    this.paused.add(media);
    this.playing.delete(media);
    try {
      media.pause();
    } catch {
      this.paused.delete(media);
      return;
    }
    this.opts.notice(media);
  }
}
