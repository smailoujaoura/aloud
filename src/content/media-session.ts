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
   * The icon as a `data:` URL. Chromium refuses artwork from any scheme but http(s), data and
   * blob — an extension URL is dropped with a console warning — so the background reads the
   * packaged icon once and hands it over as data, which every browser accepts.
   */
  private artwork: string | null = null;
  private lastMetadata: [string, string, string] | null = null;
  private disposed = false;
  /** What the page's media session showed before Aloud took it, to put back afterwards. */
  private previous: { metadata: MediaMetadata | null; playbackState: MediaSessionPlaybackState } | null = null;

  constructor(handlers: MediaHandlers, artwork?: () => Promise<string | null>) {
    const session = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;
    // A page that already uses its media session (YouTube, a podcast player, a music site) keeps
    // it. Taking it over and letting go meant clearing its handlers and its "now playing" — and a
    // page's own handlers cannot be read, so they cannot be put back: its media keys and lock
    // screen stayed dead until a reload. Aloud's own keys and the bar work there as before.
    //
    // Handlers cannot be read either, so a page that set only those looks unused. A page with
    // media of its own (Aloud's audio element is never in the document) is taken to be using its
    // media session too.
    const pageOwnsIt =
      !!session &&
      (session.metadata != null ||
        session.playbackState !== 'none' ||
        (typeof document !== 'undefined' && document.querySelector('audio, video') != null));
    this.session = pageOwnsIt ? null : session;
    if (this.session) this.previous = { metadata: this.session.metadata, playbackState: this.session.playbackState };
    if (artwork && this.session) void this.loadArtwork(artwork);
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
    if (this.disposed) return;
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

  /**
   * The icon, as a data: URL from the background. Chromium refuses artwork from an extension URL,
   * and the icon is not web-accessible anyway (pages could use it to recognise Aloud).
   */
  private async loadArtwork(load: () => Promise<string | null>): Promise<void> {
    try {
      const url = await load();
      // Arriving after this reader closed: the media session is someone else's again, and
      // writing this reader's title into it now overwrote theirs.
      if (!url || this.disposed) return;
      this.artwork = url;
      if (this.lastMetadata) this.setMetadata(...this.lastMetadata);
    } catch {
      /* no artwork, then */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lastMetadata = null;
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
      this.session.metadata = this.previous?.metadata ?? null;
      this.session.playbackState = this.previous?.playbackState ?? 'none';
    } catch {
      /* noop */
    }
  }
}
