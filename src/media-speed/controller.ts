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
 * The speed shown is the speed the videos play at, whether it was asked for here or remembered
 * for the site ("this site was last watched at 1.75×"). Each new video gets it once it loads: a
 * load sets the speed back to the default, often with no `ratechange` to say so, and a remembered
 * speed offered only to what was on the page at first was undone by the video's own load after a
 * reload — the speed button said 3× over a video playing at 1×. A rate asked for here is also put
 * back on every `play`/`canplay`; a remembered one only per new video, so that a player firing
 * those as its progress bar is dragged is left to the seek handling below.
 *
 * And a rate the *player* sets for its own reasons is not the viewer's choice at all. Facebook
 * puts its own rate back after every seek, so one click on the progress bar was read as "the
 * viewer wants 1×" — the speed dropped, and the site's remembered speed was overwritten with it.
 * A change arriving right after a seek or a load *that goes back to the player's own rate* is
 * the player settling, never a choice: it is never remembered, and the speed is put back (a few
 * times; a player that insists keeps its own, rather than the two flickering turn by turn).
 * Both conditions, not just the timing: a viewer who seeks with an arrow key and then presses
 * YouTube's Shift+> picks a *new* rate within the same second, and that is theirs to keep.
 */
import { clampRate, formatRate, nextPreset, stepRate } from './rate';
import { isTypingEvent, matchesBinding } from './keys';
import type { MediaSpeedSettings } from '@/shared/settings';
import { readerOwnsKey } from '@/shared/reader-keys';
import { TOP_LAYER_HOST_STYLE, lower, raise, topLayerHost } from './top-layer';
import { TouchSpeedButton } from './touch-button';

/** Aloud's own reading bar: its keys are its own (see ui/control-bar.ts). */
const CONTROL_HOST_ID = 'aloud-control-host';
const BADGE_HOST_ID = 'aloud-speed-badge';
const BADGE_MS = 1400;
/** A rate change this soon after a seek or a load is the player settling, not the viewer. */
const SETTLE_MS = 1200;
/** How soon after a click or key a rate change must come to be that input's doing. */
const INPUT_MS = 120;
/** How often, at most, the whole page is looked through again for players (see `start`). */
const RESCAN_MS = 500;
/** How often to put a chosen rate back before letting an insistent player keep its own. */
const MAX_OVERRIDES = 3;

export interface ControllerHost {
  settings: MediaSpeedSettings;
  /** Rate to start from: the site's remembered rate, `startAt`, or null to leave media alone. */
  initialRate: number | null;
  /** Called when the rate changes, so it can be remembered for this site. */
  onRate(rate: number): void;
  /** Called for each media element as it is found (the autoplay guard); returns its unhook. */
  onMedia?(media: HTMLMediaElement): () => void;
  /**
   * A touch device, with no keys: the speed button on the video (touch-button.ts) is always there,
   * whatever `showButton` says, since it is the only way to change the speed.
   */
  touchButton?: boolean;
}

type Media = HTMLMediaElement;

export class MediaSpeedController {
  private rate: number | null = null;
  /** True once the rate is a choice made here — by a key, or through the site's own speed menu. */
  private chosen = false;
  /** The rate we set last, to tell our own `ratechange` from the site's. */
  private applied = new WeakMap<Media, number>();
  /** When each player last seeked or loaded — a rate change just after that is its own doing. */
  private settled = new WeakMap<Media, number>();
  /** How often the chosen rate has been put back since this player last seeked or loaded. */
  private overrides = new WeakMap<Media, number>();
  /** When the viewer last clicked, tapped or pressed a key. */
  private lastInput = -Infinity;
  /**
   * When the press behind that input began: the `pointerdown` of a click, not its `click`. A player
   * that seeks on the press and puts its own rate back on the release did both in one gesture.
   */
  private gestureAt = -Infinity;
  /** A pointer or finger is down, and its release belongs to the press that began `gestureAt`. */
  private pressing = false;
  /** When each player last began to seek (its `seeking` event). */
  private seekStarted = new WeakMap<Media, number>();
  /** When each player's sound last went off or on (its `volumechange`): see `onRateChange`. */
  private soundAt = new WeakMap<Media, number>();
  /** Whether each player was silent when last heard from: a change not yet announced shows. */
  private heard = new WeakMap<Media, boolean>();
  /**
   * The sound the viewer chose with the mute key where Aloud had to switch it itself (true:
   * silent). The player never heard of that choice, and gave the next video its own sound again:
   * sound turned on, then muted on every new video. Null: the site's own sound rules, as when the
   * site answered the key itself (YouTube). The site's own mute button, used on a playing video,
   * changes it (see `onSound`).
   */
  private wantSilent: boolean | null = null;
  /** Players that have begun playing what they hold now, and when: see `onSound`. */
  private begun = new WeakSet<Media>();
  private startedAt = new WeakMap<Media, number>();
  /** The sound Aloud set on each player last, to tell its own `volumechange` from the player's. */
  private soundSetTo = new WeakMap<Media, boolean>();
  /** How often the chosen sound has been put back on this video: see `keepSound`. */
  private soundTries = new WeakMap<Media, number>();
  /** Players whose `seeking` event has come and whose `seeked` has not yet. */
  private inSeek = new WeakSet<Media>();
  /** Each player's video address, less what only says where to start (see `addressOf`). */
  private address = new WeakMap<Media, string>();
  /** Players that loaded the same video again, to move within it: the rate goes back on once. */
  private reloaded = new WeakSet<Media>();
  /** Shadow roots that hold a player, watched like the document itself (see `watchRoots`). */
  private readonly watchedRoots = new WeakSet<ShadowRoot>();
  /** The rate each player had of its own before we first set ours — what it resets *to*. */
  private native = new WeakMap<Media, number>();
  /** Players that have loaded a *different* video since the rate was last applied to them. */
  private freshSource = new WeakSet<Media>();
  private readonly known = new Set<Media>();
  /** How to unhook each tracked element, so a removed one can be let go of entirely. */
  private readonly listeners = new Map<Media, () => void>();
  private observer: MutationObserver | null = null;
  private rescanTimer = 0;
  private badge: { host: HTMLElement; text: HTMLElement; timer: number } | null = null;
  private touch: TouchSpeedButton | null = null;
  private readonly cleanups: Array<() => void> = [];
  private settings: MediaSpeedSettings;

  constructor(private readonly host: ControllerHost) {
    this.settings = host.settings;
  }

  start(): void {
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) this.scanFrom(node);
      }
      // What was added has been looked through above. The whole page again, for what no record
      // names (a player inside a web component attached afterwards), and to let go of players
      // that have left: twice a second at most. Done for every change, on a page that never
      // stops changing (a feed, a ticker, an animation that edits the page), it walked every
      // element of the page dozens of times a second.
      if (records.length && !this.rescanTimer) {
        this.rescanTimer = window.setTimeout(() => {
          this.rescanTimer = 0;
          if (!this.observer) return;
          this.scan();
          this.prune();
        }, RESCAN_MS);
      }
    });
    // `document`, not its root element: started with the page, there may not be one yet.
    this.observer.observe(document, { childList: true, subtree: true });
    // After the observer exists: a player found inside a shadow root has that root watched too.
    this.scan();
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent), true);
    // The viewer's own input, seen before the page handles it (capture): a rate change that
    // follows a click or key at once is a choice, even straight after a seek (see `onRateChange`).
    // `click` and `pointerup` too: a site's speed menu acts on the click, not the press.
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'touchstart', 'touchend']) {
      this.listen(window, type, () => this.onInput(type), true);
    }
    this.syncButton();
  }

  /**
   * The speed button on the video (touch-button.ts): always on a phone, and on a computer while
   * the settings ask for it. Turned off in Settings, it goes from the page at once.
   */
  private syncButton(): void {
    const wanted = !!this.observer && (!!this.host.touchButton || this.settings.showButton);
    if (!wanted) {
      this.touch?.stop();
      this.touch = null;
      return;
    }
    if (this.touch) return;
    const touch = new TouchSpeedButton({
      rate: () => this.rate ?? currentRateOf(this.known) ?? 1,
      setRate: (rate) => {
        if (this.known.size) this.setRate(rate, false);
      },
      stepFrom: (rate, direction) => stepRate(rate, this.settings.step, direction),
      player: () => {
        this.prune();
        return activeMedia(this.known);
      },
      playerAt: (x, y) => videoAt(this.known, x, y),
    });
    touch.start();
    this.touch = touch;
  }

  /** A click, tap or key: when it happened, and when the press it belongs to began. */
  private onInput(type: string): void {
    const now = Date.now();
    this.lastInput = now;
    if (type === 'pointerdown' || type === 'touchstart') {
      this.pressing = true;
      this.gestureAt = now;
    } else if (type === 'keydown') {
      this.pressing = false;
      this.gestureAt = now;
    } else {
      // A release or a click with no press before it (a click from the keyboard) begins its own.
      if (!this.pressing) this.gestureAt = now;
      if (type === 'click') this.pressing = false;
    }
  }

  /** Stop, and let go of every player. `farewell`: said over the page for a moment as it goes. */
  stop(farewell?: string): void {
    if (farewell) this.showBadge(farewell, undefined, true);
    this.observer?.disconnect();
    this.observer = null;
    this.syncButton();
    clearTimeout(this.rescanTimer);
    this.rescanTimer = 0;
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    for (const release of this.listeners.values()) release();
    const badge = farewell ? this.badge : null;
    if (badge) {
      this.badge = null;
      window.setTimeout(() => {
        clearTimeout(badge.timer);
        badge.host.remove();
      }, BADGE_MS * 2);
    } else {
      this.clearBadge();
    }
    this.known.clear();
    this.listeners.clear();
  }

  setSettings(settings: MediaSpeedSettings): void {
    this.settings = settings;
    // The button follows `showButton` at once. A control that has stopped (its key, or switched
    // off) still hears of every change, and puts nothing back (see syncButton).
    this.syncButton();
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
    // A fresh choice: this player has not overridden *this* one yet.
    this.overrides = new WeakMap();
    for (const media of this.known) this.apply(media);
    // One speed on the video, not two: the speed button, where the viewer dragged it, when it is
    // on (touch-button.ts); the fixed badge only when it is off. Both follow "Show the speed on the
    // video when it changes".
    if (show && this.settings.showBadge) {
      if (this.touch) this.touch.wake();
      else this.showBadge(formatRate(this.rate));
    }
    this.touch?.refresh();
    this.host.onRate(this.rate);
  }

  private apply(media: Media): void {
    if (this.rate == null) return;
    try {
      this.applied.set(media, this.rate);
      this.freshSource.delete(media);
      this.reloaded.delete(media);
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
    this.native.set(media, media.playbackRate);
    this.heard.set(media, silent(media));
    this.startedAt.set(media, Date.now());
    if (!media.paused) this.begun.add(media);
    // A player just found is one the page is still setting up: a player that swaps in a second
    // `<video>`, already loaded at the new position, to move within the video gave it its own 1×
    // a moment later, with no seek or load on it to show it was busy. Read as the viewer's choice,
    // one click on the progress bar dropped the speed and stored 1× as the site's speed.
    this.settled.set(media, Date.now());
    this.address.set(media, addressOf(media));
    this.watchRoots(media);

    // A new source resets the rate to 1; put ours back. `ratechange` tells the site's own speed
    // menu from our own writes, and follows the site when it was not us.
    // A new video, or the same one loaded again, gets the speed once it loads: see the note at the
    // top of the file. A speed chosen here goes back on at every one of these events.
    const reapply = (): void => {
      if (this.chosen || this.reloaded.has(media) || this.freshSource.has(media)) this.apply(media);
    };
    const off: Array<() => void> = [];
    // A video starting shows its speed button for a moment, where there is one.
    // A video starting shows its button for a moment, on that video. On a computer not for a muted
    // one: a muted video starting by itself is a preview under the mouse or one in the background,
    // and the button popped up over thumbnails all down the page.
    const wake = (): void => {
      if (this.host.touchButton || !media.muted) this.touch?.wake(media);
    };
    media.addEventListener('play', wake);
    off.push(() => media.removeEventListener('play', wake));
    for (const event of ['loadstart', 'loadeddata', 'canplay', 'play', 'playing', 'durationchange']) {
      media.addEventListener(event, reapply);
      off.push(() => media.removeEventListener(event, reapply));
    }
    // When the player is busy with a seek or a new source: see `fromPlayer` below.
    const settle = (): void => {
      this.settled.set(media, Date.now());
      // Each seek starts afresh: the limit is there to stop one seek turning into a tug of war,
      // not to give up on a long video the viewer moves around in.
      this.overrides.delete(media);
    };
    // A different video, as opposed to a move within this one: see `onRateChange`.
    // Some players move within a video by loading it again from the new position
    // (`clip.mp4?start=120`). Taken for another video, a speed that came from memory was left
    // behind, and every click on the progress bar dropped it to 1×. The same address, less where
    // it starts, is the same video. It is compared with the address of the load before, which
    // only `loadstart` replaces: stored on `emptied`, which comes first, a new video would already
    // look like the same one again by its own `loadstart`.
    const newSource = (e: Event): void => {
      const now = addressOf(media);
      const before = this.address.get(media);
      if (e.type === 'loadstart' && now) this.address.set(media, now);
      if (now && now === before) {
        this.freshSource.delete(media);
        this.reloaded.add(media);
      } else {
        this.freshSource.add(media);
        this.reloaded.delete(media);
      }
    };
    for (const event of ['emptied', 'loadstart']) {
      media.addEventListener(event, newSource);
      off.push(() => media.removeEventListener(event, newSource));
    }
    // The sound: a change of it is no choice of speed (see `onRateChange`), and the sound chosen
    // with the mute key goes on to the next video (see `wantSilent`).
    const onSound = (): void => this.onSound(media);
    const newVideo = (): void => {
      this.soundTries.delete(media);
      this.begun.delete(media);
      this.startedAt.set(media, Date.now());
    };
    const started = (): void => {
      if (!this.begun.has(media)) {
        this.begun.add(media);
        this.startedAt.set(media, Date.now());
      }
      this.keepSound(media);
    };
    media.addEventListener('volumechange', onSound);
    media.addEventListener('playing', started);
    off.push(() => {
      media.removeEventListener('volumechange', onSound);
      media.removeEventListener('playing', started);
    });
    for (const event of ['emptied', 'loadstart']) {
      media.addEventListener(event, newVideo);
      off.push(() => media.removeEventListener(event, newVideo));
    }
    for (const event of ['seeking', 'seeked', 'loadstart', 'loadeddata', 'canplay', 'playing', 'emptied', 'durationchange']) {
      media.addEventListener(event, settle);
      off.push(() => media.removeEventListener(event, settle));
    }
    // Which seek, and whether its `seeking` has arrived yet: see `onRateChange`.
    const seekBegins = (): void => {
      this.seekStarted.set(media, Date.now());
      this.inSeek.add(media);
    };
    const seekEnds = (): void => void this.inSeek.delete(media);
    media.addEventListener('seeking', seekBegins);
    off.push(() => media.removeEventListener('seeking', seekBegins));
    for (const event of ['seeked', 'emptied']) {
      media.addEventListener(event, seekEnds);
      off.push(() => media.removeEventListener(event, seekEnds));
    }
    const onRateChange = (): void => {
      if (this.rate == null) return;
      const ours = this.applied.get(media);
      if (media.playbackRate === ours) return;

      // The player's own doing — it is mid-seek or mid-load, or has just finished one. Facebook
      // restores its rate on every `seeked`, which read as a viewer asking for 1×.
      const settledAt = this.settled.get(media) ?? -Infinity;
      const since = Date.now() - settledAt;
      // Somebody chose this rate if a click or key came after the player finished seeking *and*
      // the change follows that input at once: a site sets the speed you picked inside the click
      // or key handler, so the change lands within milliseconds of it. Any input after the seek
      // was not enough — a stray click 150 ms after a seek let a reset arriving 400 ms after it
      // pass for a choice, and Facebook's 1× was taken and remembered again.
      const recentInput = Date.now() - this.lastInput <= INPUT_MS;
      // Nor when the input is the seek itself. A player that resets the rate in the same click
      // handler that sets the position, the reset first, has its `ratechange` queued ahead of its
      // `seeking`: the change came before any sign of a seek, straight after a click, and the
      // player's 1× was followed and remembered. `seeking` is already true then, though its event
      // has not come: a seek begun in the same moment as the change.
      const seekPending = media.seeking && !this.inSeek.has(media);
      // And a player that seeks on the press and resets on the release (or after a long drag, two
      // seconds later) did both in one gesture: a change during the press that moved the video is
      // the player's, however long the press lasted.
      const seekGesture = recentInput && this.gestureAt <= (this.seekStarted.get(media) ?? -Infinity);
      // Nor a change that comes with the sound going off or on: a player that sets its whole state
      // again on a mute (Facebook) put its own 1× back, and a mute cost the speed and stored 1× for
      // the site. Its `volumechange` may not have come yet: the sound is already other than heard.
      const soundAt = this.soundAt.get(media) ?? -Infinity;
      const withSound =
        silent(media) !== (this.heard.get(media) ?? silent(media)) ||
        (Date.now() - soundAt <= SETTLE_MS && this.lastInput <= soundAt);
      const chosenSince = this.lastInput > settledAt && recentInput && !seekPending && !seekGesture && !withSound;
      const settling = !chosenSince && (media.seeking || media.readyState < 2 || since < SETTLE_MS || seekGesture || withSound);
      // What a player resets to: the rate it had before ours, its default, or plain 1×. Any other
      // value is somebody choosing a speed, however soon after a seek it comes.
      const now = media.playbackRate;
      const reset =
        now === 1 || now === media.defaultPlaybackRate || now === this.native.get(media);
      if (settling && reset) {
        // Put our speed back: the viewer moved within the video, or a new one loaded, and the
        // player reset the rate behind them. A remembered speed as much as a chosen one: the
        // speed shown is the one the video plays at (see the top of the file).
        const tries = (this.overrides.get(media) ?? 0) + 1;
        this.overrides.set(media, tries);
        // Put it back — unless this player keeps taking it, in which case the two would flicker
        // turn by turn for as long as the video ran.
        if (tries <= MAX_OVERRIDES) {
          this.apply(media);
          return;
        }
        // Follow it on screen, but never remember it: a click must not rewrite the site's speed.
        this.rate = clampRate(media.playbackRate);
        this.touch?.refresh();
        // And it is the rate on this player now. Left at our earlier write, a later choice of
        // that same rate looked like our own echo and was ignored — then "faster" stepped from
        // the stale 1× and turned 1.75× into 1.1×.
        this.applied.set(media, media.playbackRate);
        return;
      }

      // The viewer changed it through the site's own speed menu: follow, and match the rest.
      this.chosen = true;
      this.rate = clampRate(media.playbackRate);
      this.touch?.refresh();
      this.applied.set(media, this.rate); // ours now too: the player restoring it later is no news
      // And it is the player's own setting now, what it puts back after a seek. A player that
      // restores its menu's speed (1.25×, chosen there earlier) after every seek, once the viewer
      // had gone on to 1.5× with Aloud's keys, had that 1.25× taken for a new choice and stored.
      this.native.set(media, this.rate);
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

  /**
   * Watch the shadow roots a player sits in, as the document is watched. Changes inside a shadow
   * root are not reported to an observer of the document: a player that replaced its `<video>`
   * inside its own shadow root, on a page where nothing else changed, left the new one at 1×,
   * and the keys did nothing, as there was no longer anything here to control.
   */
  private watchRoots(media: Media): void {
    let root = media.getRootNode();
    while (root instanceof ShadowRoot) {
      if (!this.watchedRoots.has(root)) {
        this.watchedRoots.add(root);
        this.observer?.observe(root, { childList: true, subtree: true });
      }
      root = root.host.getRootNode();
    }
  }

  // ---- keys -------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (!this.settings.enabled || e.defaultPrevented || isTypingEvent(e)) return;
    // The reader, open on this page, answers S D R Z X itself.
    if (readerOwnsKey(e)) return;
    // Aloud's reading bar handles its own keys.
    if (e.composedPath().some((n) => n instanceof HTMLElement && n.id === CONTROL_HOST_ID)) return;

    const { keys } = this.settings;
    const bound = [keys.mute, keys.rewind, keys.advance, keys.faster, keys.slower, keys.reset, keys.preferred, keys.nextPreset, keys.previousPreset];
    if (!bound.some((binding) => matchesBinding(e, binding))) return;
    // With nothing here to control, the letters are the page's: S, D, R, Z and X were taken, and a
    // "No video or audio here" shown, on every site the control runs on, a page of text included.
    // Asked only for one of its own keys: it measures the players, which is layout work.
    this.prune();
    if (![...this.known].some(controllable)) return;
    if (matchesBinding(e, keys.mute)) {
      if (!e.repeat) this.toggleMute(e.code);
      return;
    }
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
    this.setRate(next);
  }

  // ---- mute -----------------------------------------------------------------------------

  /**
   * Sound off, and on again, for the video you are watching.
   *
   * Unlike the speed keys, the key is not taken from the page: YouTube, Netflix and most players
   * mute on M themselves, and a player muted behind its back shows its own volume icon wrong. So
   * the page goes first, and only if the sound is as it was a moment later does Aloud switch it.
   * "A moment later" is after the key comes back up: a player that mutes on keyup, with the key
   * held longer than a fixed wait, was muted by Aloud and unmuted by itself. Held down, the key
   * repeats: only the first press counts. With nothing to mute, M is left alone entirely: on
   * most pages it means something else.
   */
  private toggleMute(code: string): void {
    this.prune();
    const media = activeMedia([...this.known].filter(controllable));
    if (!media) return;
    const before = silent(media);
    let decided = false;
    const onUp = (up: KeyboardEvent): void => {
      if (up.code === code) window.setTimeout(decide, MUTE_AFTER_PAGE_MS);
    };
    // A keyup that never comes (focus moved to another window mid-press) still ends it.
    const fallback = window.setTimeout(() => decide(), MUTE_AFTER_PAGE_MS + 1000);
    window.addEventListener('keyup', onUp, true);
    const decide = (): void => {
      if (decided) return;
      decided = true;
      window.removeEventListener('keyup', onUp, true);
      window.clearTimeout(fallback);
      if (!media.isConnected) return;
      if (silent(media) === before) {
        // Switched here, behind the player's back: kept for the videos after this one too.
        this.wantSilent = !before;
        this.setSilent(media, !before);
      } else {
        this.wantSilent = null; // the page answered the key itself, and knows
      }
      this.showBadge(silent(media) ? 'Muted' : 'Sound on', media);
    };
  }

  /** Sound off or on, as Aloud's own doing (its `volumechange` is then not news). */
  private setSilent(media: Media, off: boolean): void {
    this.soundSetTo.set(media, off);
    if (off) {
      media.muted = true;
      return;
    }
    media.muted = false;
    if (media.volume === 0) media.volume = 1; // a player that mutes by turning the volume down
  }

  /**
   * A player's sound went off or on. Aloud's own doing is no news.
   *
   * On a video starting (not yet playing what it holds, or only just), it is the player setting it
   * up: the sound chosen with the mute key is put back. On a video already playing, it is the
   * viewer, with the site's own button or key, if it stays: the same video still playing, with
   * that sound, a moment later, and that sound becomes the one the next videos get. A player
   * moving to its next video mutes the one it leaves first (Facebook): that is no choice, and was
   * taken for one when a key or click had come just before, so M's sound was dropped for good.
   * Nothing here asks what was clicked or pressed.
   */
  private onSound(media: Media): void {
    const now = silent(media);
    const changed = this.heard.get(media) !== now;
    this.heard.set(media, now);
    if (!changed) return; // the volume moved, the sound stayed on
    this.soundAt.set(media, Date.now());
    // Each change of sound starts afresh, as a seek does: a player that resets the speed on every
    // mute must not use up the speed's tries in three presses of M.
    this.overrides.delete(media);
    const ours = this.soundSetTo.get(media);
    this.soundSetTo.delete(media);
    if (ours === now) return;
    const since = this.startedAt.get(media) ?? -Infinity;
    if (!this.begun.has(media) || Date.now() - since < SETTLE_MS) {
      this.keepSound(media);
      return;
    }
    if (this.wantSilent == null) return; // the site's own sound rules here: nothing to follow
    window.setTimeout(() => {
      if (this.wantSilent == null || !media.isConnected || media.paused) return;
      if (this.startedAt.get(media) !== since || silent(media) !== now) return; // it moved on
      if (activeMedia([...this.known].filter(controllable)) !== media) return;
      this.wantSilent = now;
    }, SETTLE_MS);
  }

  /**
   * The sound chosen with the mute key, on a video the player gave another: playing, and one the
   * keys are for (a small muted preview elsewhere on the page is not given sound). A few times per
   * video at most, so a player that insists is not fought for as long as it plays.
   */
  private keepSound(media: Media): void {
    const want = this.wantSilent;
    if (want == null || !media.isConnected || media.paused || silent(media) === want) return;
    if (!controllable(media)) return;
    const tries = (this.soundTries.get(media) ?? 0) + 1;
    this.soundTries.set(media, tries);
    if (tries > MAX_OVERRIDES) return;
    this.setSilent(media, want);
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
    const media = activeMedia([...this.known].filter(controllable));
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
    let top = box ? Math.max(8, box.top + 12) : 16;
    const left = box ? Math.max(8, box.left + 12) : 16;
    badge.host.style.display = 'block';
    // Just below the speed button when that is up in the same corner: a key pressed with the mouse
    // over the video put the two on top of each other.
    const chip = this.touch?.onScreen();
    if (chip) {
      const size = badge.host.getBoundingClientRect();
      if (left < chip.right && left + size.width > chip.left && top < chip.bottom && top + size.height > chip.top) top = chip.bottom + 6;
    }
    badge.host.style.top = `${top}px`;
    badge.host.style.left = `${left}px`;
    raise(badge.host);
    clearTimeout(badge.timer);
    badge.timer = window.setTimeout(() => {
      if (!this.badge) return;
      this.badge.host.style.display = 'none';
      lower(this.badge.host);
    }, always ? BADGE_MS * 2 : BADGE_MS);
  }

  private createBadge(): { host: HTMLElement; text: HTMLElement; timer: number } | null {
    const parent = document.body ?? document.documentElement;
    if (!parent) return null;
    const host = document.createElement('div');
    host.id = BADGE_HOST_ID;
    // A popover where the browser has them: shown above a video in full screen (top-layer.ts).
    topLayerHost(host);
    host.style.cssText = `${TOP_LAYER_HOST_STYLE}pointer-events:none;`;
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
    // Removed by `clearBadge` when the control stops (or a moment after, with a farewell).
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

/**
 * Where a player's video comes from, for telling a reload of the same video from another one:
 * its address without the fragment (`#t=120`) or a query parameter that only says where to start.
 */
const START_PARAMS = /^(t|start|starttime|start_time|begin|from|offset|time|pos|position|seek|ss)$/i;

function addressOf(media: Media): string {
  const raw = media.getAttribute('src') != null ? media.src : media.currentSrc;
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) if (START_PARAMS.test(name)) url.searchParams.delete(name);
    return url.href;
  } catch {
    return raw;
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
/** How long after the key comes up the page has had to answer it itself, before Aloud does. */
const MUTE_AFTER_PAGE_MS = 120;

/** The largest video big enough for the speed button that is under (x, y), if any. */
function videoAt(media: Iterable<Media>, x: number, y: number): Media | null {
  let best: Media | null = null;
  let bestArea = 0;
  for (const el of media) {
    if (!(el instanceof HTMLVideoElement) || !el.isConnected) continue;
    const box = el.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
    const area = box.width * box.height;
    if (box.width >= 160 && box.height >= 90 && area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

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

/**
 * Something the keys are for: a video on screen big enough to watch (a Short muted and looping
 * included), one playing or played with its sound on, audio playing, or audio the page is plainly
 * there to play — an audio player showing its controls, or a podcast or audiobook behind the site's
 * own buttons, whose speed can be set before pressing play. Not a small or hidden player waiting in
 * a corner, a muted preview playing out of sight, nor a page's short click or notification sound.
 */
export function controllable(media: Media): boolean {
  if (!media.isConnected) return false;
  const playing = !media.paused && !media.ended;
  const audible = !media.muted && media.volume > 0;
  const box = media.getBoundingClientRect();
  const onScreen = box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
  if (media instanceof HTMLVideoElement) {
    if (onScreen && box.width >= 200 && box.height >= 110) return true;
    return (playing || (media.played?.length ?? 0) > 0) && audible;
  }
  if (playing || (media.controls && onScreen && box.width > 0)) return true;
  // A recording, not a sound effect: it has a source, and is not known to be a few seconds long.
  const source = !!(media.currentSrc || media.getAttribute('src') || media.querySelector('source[src]'));
  return source && !(Number.isFinite(media.duration) && media.duration < 30);
}

/** No sound from it: muted, or its volume all the way down. */
function silent(media: Media): boolean {
  return media.muted || media.volume === 0;
}

/** 83 → "1:23"; 3723 → "1:02:03". */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
