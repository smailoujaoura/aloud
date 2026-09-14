/**
 * Media keys, headphone buttons, the OS media overlay and the Android lock screen.
 *
 * All of those are delivered through the Media Session API to whichever page is playing media —
 * which is only possible because the scheduler routes Aloud's audio through an `<audio>` element
 * (see `connectOutput` in audio/scheduler.ts). This module is the other half: it tells the
 * browser what is playing and what the buttons should do.
 *
 * Everything is best-effort. A page may already own the media session, a browser may expose it
 * differently to content scripts, and none of that is worth failing a read over.
 */

export interface MediaHandlers {
  play(): void;
  pause(): void;
  previous(): void;
  next(): void;
}

type Action = 'play' | 'pause' | 'previoustrack' | 'nexttrack' | 'seekbackward' | 'seekforward' | 'stop';

export class MediaControls {
  private readonly session: MediaSession | null;
  private readonly actions: Action[] = [];
  /**
   * The icon as a `blob:` URL. Chromium refuses artwork from any scheme but http(s), data and
   * blob — an extension URL is dropped with a console warning — so the packaged icon is read once
   * and handed over as a blob, which every browser accepts.
   */
  private artwork: string | null = null;
  private lastMetadata: [string, string, string] | null = null;

  constructor(handlers: MediaHandlers, artworkUrl?: string) {
    this.session = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;
    if (artworkUrl && this.session) void this.loadArtwork(artworkUrl);
    // "Seek" on a headset is a double or triple tap, and to a listener that means "back a bit" or
    // "on a bit" — a sentence, the same step as the bar's own buttons. "Stop" pauses rather than
    // closing the reader: an OS overlay is too easy to hit by accident to throw away a session.
    this.bind('play', handlers.play);
    this.bind('pause', handlers.pause);
    this.bind('stop', handlers.pause);
    this.bind('previoustrack', handlers.previous);
    this.bind('nexttrack', handlers.next);
    this.bind('seekbackward', handlers.previous);
    this.bind('seekforward', handlers.next);
  }

  private bind(action: Action, handler: () => void): void {
    try {
      this.session?.setActionHandler(action, () => handler());
      this.actions.push(action);
    } catch {
      /* this browser does not support that action */
    }
  }

  /** What the OS overlay shows: the article, the voice, and the site it came from. */
  setMetadata(title: string, voice: string, site: string): void {
    this.lastMetadata = [title, voice, site];
    if (!this.session || typeof MediaMetadata === 'undefined') return;
    try {
      this.session.metadata = new MediaMetadata({
        title: title || 'Aloud',
        artist: voice,
        album: site,
        artwork: this.artwork ? [{ src: this.artwork, sizes: '128x128', type: 'image/png' }] : [],
      });
    } catch {
      /* metadata is decorative */
    }
  }

  setPlaying(state: 'playing' | 'paused' | 'none'): void {
    try {
      if (this.session) this.session.playbackState = state;
    } catch {
      /* noop */
    }
  }

  /** Hand the media session back to the page. */
  private async loadArtwork(url: string): Promise<void> {
    try {
      const blob = await (await fetch(url)).blob();
      this.artwork = URL.createObjectURL(blob);
      if (this.lastMetadata) this.setMetadata(...this.lastMetadata);
    } catch {
      /* no artwork, then */
    }
  }

  dispose(): void {
    if (this.artwork) URL.revokeObjectURL(this.artwork);
    this.artwork = null;
    if (!this.session) return;
    for (const action of this.actions) {
      try {
        this.session.setActionHandler(action, null);
      } catch {
        /* noop */
      }
    }
    try {
      this.session.metadata = null;
      this.session.playbackState = 'none';
    } catch {
      /* noop */
    }
  }
}
