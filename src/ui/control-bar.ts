/**
 * The in-page playback control bar.
 *
 * Rendered inside a closed Shadow DOM attached to `<html>`, so the host page's CSS can never
 * touch it and its own styles never leak out. All DOM is built with `createElement` — never
 * `innerHTML` — which is both an XSS-safety property on pages we do not control and what keeps
 * `web-ext lint` clean for AMO review.
 *
 * The bar is a *view*: it renders `SessionState` and reports intent through callbacks. It holds
 * no playback state of its own beyond what it needs to avoid redundant DOM work.
 *
 * Two rules the layout obeys, everywhere:
 *  - the bar's own size is a function of the viewport, never of what it is saying, so nothing a
 *    message does can shift a button under the pointer. Status, the scrub preview and the
 *    first-run tips are separate elements floated above it;
 *  - every action reports back. A press either changes something visible immediately or says
 *    what it is waiting for — `flash()` for the instant confirmations, the status pill for the
 *    waits that outlive a keystroke.
 */
import { el, svgIcon } from '@/shared/dom';
import { groupByLanguage, voiceValue, type EngineVoice } from '@/shared/voice-catalog';
import { ENGINE_IDS, engineInfo } from '@/shared/engine-catalog';
import type { SessionState } from '@/shared/messages';
import type { ThemeChoice } from '@/shared/settings';
import { CONTROL_BAR_CSS } from './control-bar-styles';
import { ICON_PATHS } from './icons';
import { resolveTheme, watchSystemTheme } from './theme';
import type { SleepChoice, SleepState } from '@/content/sleep-timer';
import { containTyping } from './contain-typing';

/** Where "Save as MP3" is, as the bar shows it. */
export type ExportState =
  | { phase: 'idle' }
  | { phase: 'running'; done: number; total: number }
  | { phase: 'done'; seconds: number; bytes: number }
  | { phase: 'error'; message: string };

export interface ControlBarCallbacks {
  onPlay(): void;
  onPause(): void;
  onPrev(): void;
  onNext(): void;
  onSeekFraction(fraction: number): void;
  onSpeed(speed: number): void;
  onVoice(voice: string): void;
  /** The "click a sentence in the page to jump there" toggle in the bar was flipped. */
  onToggleTapToSeek(enabled: boolean): void;
  /** Scroll the page back to the sentence being read. */
  onSnapToCurrent(): void;
  /** Keep the sentence being heard (or the selection) in Notes. */
  onSaveNote(): void;
  /** Replay the last few seconds and show where that is. */
  onBackALittle(): void;
  /** A sleep-timer option was picked from the moon button's menu. */
  onSleep(choice: SleepChoice): void;
  /** Start turning the whole document into an MP3. */
  onExportStart(): void;
  onExportCancel(): void;
  /** Hand the finished MP3 to the browser's downloads. Called from the click, so it may. */
  onExportSave(): void;
  onOpenSettings(): void;
  /** The tips card's "How Aloud works" link — opens the walkthrough page. */
  onOpenWalkthrough(): void;
  /** The tips card was dismissed; it should never be shown again. */
  onTipsDismissed(): void;
  onClose(): void;
}

export interface ControlBarOptions {
  speed: number;
  tapToSeek: boolean;
  theme: ThemeChoice;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];

/** How long a `flash()` confirmation stays up before the bar goes back to reporting status. */
const FLASH_MS = 1900;
/** …and one that carries a button, which needs time to be read *and* reached. */
const FLASH_ACTION_MS = 8000;

/** A one-click follow-up offered inside a flash, e.g. "Start over" after resuming. */
export interface FlashAction {
  label: string;
  run(): void;
}

/** The sleep timer's choices, in menu order. */
const SLEEP_LABEL = new Map<SleepChoice, string>([
  ['paragraph', 'At the end of this paragraph'],
  ['section', 'At the end of this section'],
  [15, 'In 15 minutes'],
  [30, 'In 30 minutes'],
  [45, 'In 45 minutes'],
  [60, 'In an hour'],
  ['off', 'Off'],
]);

/** Shadow host id. `content/tap-to-seek` uses it to ignore clicks landing on our own UI. */
export const CONTROL_HOST_ID = 'aloud-control-host';

/** What the play button is showing. */
type PlayMode = 'play' | 'pause' | 'loading';

export class ControlBar {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;

  private dock!: HTMLDivElement;
  private bar!: HTMLDivElement;
  private toast!: HTMLElement;
  private tips: HTMLElement | null = null;
  private sleepBtn!: HTMLButtonElement;
  private sleepBadge!: HTMLElement;
  private sleepState: SleepState = { choice: 'off', badge: '', stopAfter: null };
  private saveBtn!: HTMLButtonElement;
  private saveBadge!: HTMLElement;
  private exportState: ExportState = { phase: 'idle' };
  /** The open menu (sleep timer or export), the button that opened it, and its dismiss listeners. */
  private popover: {
    menu: HTMLElement;
    button: HTMLButtonElement;
    page: (e: Event) => void;
    bar: (e: Event) => void;
  } | null = null;
  private playBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private tapBtn!: HTMLButtonElement;
  private snapBtn!: HTMLButtonElement;
  private progressEl!: HTMLDivElement;
  private trackEl!: HTMLElement;
  private fillEl!: HTMLElement;
  private knobEl!: HTMLElement;
  private scrubEl!: HTMLElement;
  private countEl!: HTMLElement;
  private speedEl!: HTMLSelectElement;
  /** Words a minute at the current speed, beside the speed itself. */
  private rateEl!: HTMLElement;
  private voiceEl!: HTMLSelectElement;

  private playing = false;
  /** Slid out of the way while you scroll down the page (see `watchScrolling`). */
  private tucked = false;
  /** When the reader last did something that scrolls — so the page's own scrolling is ignored. */
  private userScrollAt = 0;
  private readonly lastScrollTop = new WeakMap<object, number>();
  /** How much of the window the bar covers, measured while it was showing. */
  private covered = 88;
  private readonly offWindow: Array<() => void> = [];
  private currentSpeed: number;
  private tapToSeek: boolean;
  private theme: ThemeChoice;
  private readonly unwatchTheme: () => void;
  /** Last rendered play-button mode, so `update()` only rebuilds it on a real change — otherwise
   *  the loading spinner's animation restarts on every state push. */
  private playBtnMode: PlayMode | null = null;
  /** Last state pushed in, so a flash can hand the toast back to it when it expires. */
  private lastState: SessionState | null = null;
  private flashTimer = 0;
  private flashing = false;
  /** Fraction being dragged, or null when the progress bar is at rest. */
  private dragFraction: number | null = null;

  constructor(
    private readonly doc: Document,
    private readonly cb: ControlBarCallbacks,
    opts: ControlBarOptions,
  ) {
    this.currentSpeed = opts.speed;
    this.tapToSeek = opts.tapToSeek;
    this.theme = opts.theme;

    this.host = doc.createElement('div');
    this.host.id = CONTROL_HOST_ID;
    this.host.style.cssText = 'all: initial; position: static;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    containTyping(this.root); // removed with the host
    (doc.documentElement ?? doc.body).appendChild(this.host);

    this.build(opts.speed);
    this.applyTheme();
    // "Match the system" has to keep matching it: the OS can flip to dark while a page is open.
    this.unwatchTheme = watchSystemTheme(() => {
      if (this.theme === 'system') this.applyTheme();
    }, doc.defaultView);
  }

  // ---- construction --------------------------------------------------------

  private make<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    text?: string,
  ): HTMLElementTagNameMap[K] {
    return el(this.doc, tag, attrs, text);
  }

  private iconButton(
    className: string,
    label: string,
    paths: readonly string[],
    title?: string,
  ): HTMLButtonElement {
    const btn = this.make('button', { class: className, 'aria-label': label, ...(title ? { title } : {}) });
    btn.appendChild(svgIcon(this.doc, [...paths]));
    return btn;
  }

  private build(speed: number): void {
    const style = this.doc.createElement('style');
    style.textContent = CONTROL_BAR_CSS;

    this.dock = this.make('div', { class: 'dock' });
    this.bar = this.make('div', {
      class: 'bar',
      role: 'group',
      tabindex: '0',
      'aria-label': 'Aloud playback controls',
    });

    this.toast = this.make('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: '' });

    this.playBtn = this.iconButton('play', 'Play', ICON_PATHS.play, 'Play / pause (Space)');
    this.prevBtn = this.iconButton('prev', 'Previous sentence', ICON_PATHS.prev, 'Previous sentence (←)');
    this.nextBtn = this.iconButton('next', 'Next sentence', ICON_PATHS.next, 'Next sentence (→)');
    const backBtn = this.iconButton('back', 'Back a little', ICON_PATHS.replay, 'Back a little — replay the last few seconds (B)');
    backBtn.addEventListener('click', () => this.cb.onBackALittle());
    const noteBtn = this.iconButton('note', 'Save to Notes', ICON_PATHS.bookmark, 'Save what you just heard to Notes (N)');
    noteBtn.addEventListener('click', () => this.cb.onSaveNote());
    this.snapBtn = this.iconButton(
      'snap',
      'Scroll to the sentence being read',
      ICON_PATHS.snap,
      'Scroll to the sentence being read',
    );
    this.tapBtn = this.iconButton('tap', 'Click a sentence to jump there', ICON_PATHS.target);
    const gearBtn = this.iconButton('gear', 'Settings', ICON_PATHS.gear, 'Voices, speed and theme');
    this.sleepBtn = this.iconButton('sleep', 'Sleep timer', ICON_PATHS.moon, 'Sleep timer');
    this.sleepBtn.setAttribute('aria-haspopup', 'menu');
    this.sleepBtn.setAttribute('aria-expanded', 'false');
    this.sleepBadge = this.make('span', { class: 'badge', hidden: '' });
    this.sleepBtn.appendChild(this.sleepBadge);
    this.sleepBtn.addEventListener('click', () => this.toggleSleepMenu());
    this.saveBtn = this.iconButton('save', 'Save as MP3', ICON_PATHS.download, 'Save as MP3');
    this.saveBtn.setAttribute('aria-haspopup', 'dialog');
    this.saveBtn.setAttribute('aria-expanded', 'false');
    this.saveBadge = this.make('span', { class: 'badge', hidden: '' });
    this.saveBtn.appendChild(this.saveBadge);
    this.saveBtn.addEventListener('click', () => this.toggleExportMenu());
    const closeBtn = this.iconButton('close', 'Close', ICON_PATHS.close, 'Stop reading and close');

    this.progressEl = this.make('div', {
      class: 'progress',
      role: 'slider',
      'aria-label': 'Progress through the document',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    });
    this.trackEl = this.make('span', { class: 'track' });
    this.fillEl = this.make('i');
    this.knobEl = this.make('span', { class: 'knob' });
    this.trackEl.appendChild(this.fillEl);
    this.progressEl.append(this.trackEl, this.knobEl);
    this.scrubEl = this.make('div', { class: 'scrub', hidden: '' });

    this.countEl = this.make('span', { class: 'count' }, '–/–');

    this.speedEl = this.make('select', { class: 'speed', 'aria-label': 'Speed', title: 'Speed (↑ / ↓)' });
    this.rateEl = this.make('span', { class: 'rate', hidden: '' });
    this.rateEl.title = 'Words a minute at this speed';
    for (const s of SPEEDS) {
      const opt = this.make('option', { value: String(s) }, `${s}×`);
      if (s === speed) opt.selected = true;
      this.speedEl.appendChild(opt);
    }

    this.voiceEl = this.make('select', { class: 'voice', 'aria-label': 'Voice', title: 'Voice', hidden: '' });
    this.reflectTapToSeek();

    // The four secondary buttons travel together in a group. On a phone the row cannot hold
    // every control, and a group is what stops the wrap from stranding a lone ✕ on a line of
    // its own: either they all fit beside the transport controls, or they all move down.
    const side = this.make('div', { class: 'side' });
    side.append(noteBtn, this.snapBtn, this.tapBtn, this.sleepBtn, this.saveBtn, gearBtn, closeBtn);

    this.bar.append(
      this.playBtn,
      backBtn,
      this.prevBtn,
      this.nextBtn,
      this.make('span', { class: 'sep' }),
      this.progressEl,
      this.countEl,
      // Only takes up space in the narrow layout, where the progress bar has moved to its own
      // row and the transport controls would otherwise stretch across the whole width.
      this.make('span', { class: 'spacer' }),
      this.make('span', { class: 'sep' }),
      this.speedEl,
      this.rateEl,
      this.voiceEl,
      side,
    );
    // Column order is the stacking order on screen, bottom-up: the bar sits at the bottom, the
    // status pill above it, the tips card above that. The scrub bubble belongs to the bar and is
    // absolutely positioned inside it, so it can follow the pointer without moving anything.
    this.bar.appendChild(this.scrubEl);
    this.dock.append(this.toast, this.bar);
    this.root.append(style, this.dock);

    this.playBtn.addEventListener('click', () => (this.playing ? this.cb.onPause() : this.cb.onPlay()));
    this.prevBtn.addEventListener('click', () => this.cb.onPrev());
    this.nextBtn.addEventListener('click', () => this.cb.onNext());
    this.snapBtn.addEventListener('click', () => this.cb.onSnapToCurrent());
    this.tapBtn.addEventListener('click', () => {
      this.tapToSeek = !this.tapToSeek;
      this.reflectTapToSeek();
      this.cb.onToggleTapToSeek(this.tapToSeek);
    });
    this.speedEl.addEventListener('change', () => this.cb.onSpeed(Number(this.speedEl.value)));
    this.voiceEl.addEventListener('change', () => this.cb.onVoice(this.voiceEl.value));
    gearBtn.addEventListener('click', () => this.cb.onOpenSettings());
    closeBtn.addEventListener('click', () => this.cb.onClose());

    this.wireProgress();
    this.bar.addEventListener('keydown', (e) => this.onKey(e));
    this.watchScrolling();
  }

  /**
   * Get out of the way of the page. Scrolling down means you are reading further on, and the
   * bar at the bottom of the window is sitting on exactly the lines you are moving towards; so it
   * slides away, and comes back when you scroll up, bring the pointer to the bottom edge, move
   * focus into it, or reading stops. Only *your* scrolling counts: Aloud following the sentence
   * down the page must not hide the bar it is being controlled from.
   */
  private watchScrolling(): void {
    const view = this.doc.defaultView;
    if (!view) return;
    const on = <K extends string>(target: EventTarget, type: K, fn: (e: Event) => void, capture = false): void => {
      target.addEventListener(type, fn, { capture, passive: true });
      this.offWindow.push(() => target.removeEventListener(type, fn, { capture }));
    };
    const intent = (): void => {
      this.userScrollAt = Date.now();
    };
    on(view, 'wheel', intent);
    on(view, 'touchmove', intent);
    on(view, 'pointerdown', intent);
    on(view, 'keydown', (e) => {
      if (/^(ArrowDown|ArrowUp|PageDown|PageUp|Home|End| )$/.test((e as KeyboardEvent).key)) intent();
    });
    // Captured, so a page that scrolls inside a container of its own is followed as well.
    on(
      this.doc,
      'scroll',
      (e) => {
        const target = e.target === this.doc ? view : (e.target as Element);
        const top = target === view ? view.scrollY : (target as Element).scrollTop;
        const before = this.lastScrollTop.get(target) ?? top;
        this.lastScrollTop.set(target, top);
        if (Date.now() - this.userScrollAt > 700) return;
        if (top - before > 6) this.setTucked(true);
        else if (before - top > 6) this.setTucked(false);
      },
      true,
    );
    on(view, 'mousemove', (e) => {
      if (this.tucked && (e as MouseEvent).clientY > view.innerHeight - 96) this.setTucked(false);
    });
    this.dock.addEventListener('focusin', () => this.setTucked(false));
  }

  private setTucked(tucked: boolean): void {
    if (tucked === this.tucked) return;
    // Measure while it is still in place; once tucked it reports where it went, not where it was.
    if (tucked) this.covered = this.measureCovered();
    // Never while something needs the bar: a paused reader, an open menu, a message on screen.
    if (tucked && (!this.playing || this.popover || this.flashing)) return;
    this.tucked = tucked;
    this.dock.classList.toggle('is-tucked', tucked);
  }

  private measureCovered(): number {
    const view = this.doc.defaultView;
    if (!view) return this.covered;
    const top = this.bar.getBoundingClientRect().top;
    return top > 0 ? Math.max(0, view.innerHeight - top + 12) : this.covered;
  }

  /** Pixels at the bottom of the window the bar covers when showing — for following the reader. */
  coveredHeight(): number {
    return this.tucked ? this.covered : (this.covered = this.measureCovered());
  }

  /**
   * Pointer handling for the scrubber: hover previews the sentence under the cursor, dragging
   * moves the fill with the finger, and only the release actually seeks.
   *
   * Seeking on every intermediate position would cancel and re-queue synthesis dozens of times
   * across one drag — the fill still follows the pointer, so it *looks* live, but the engine is
   * asked exactly once.
   */
  private wireProgress(): void {
    const fractionAt = (clientX: number): number => {
      const r = this.progressEl.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    };

    this.progressEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      this.progressEl.setPointerCapture(e.pointerId);
      this.progressEl.classList.add('dragging');
      this.dragFraction = fractionAt(e.clientX);
      this.renderScrub(e.clientX);
    });

    this.progressEl.addEventListener('pointermove', (e) => {
      if (this.dragFraction != null) this.dragFraction = fractionAt(e.clientX);
      this.renderScrub(e.clientX);
    });

    const finish = (e: PointerEvent): void => {
      if (this.dragFraction == null) return;
      const fraction = this.dragFraction;
      this.dragFraction = null;
      this.progressEl.classList.remove('dragging');
      try {
        this.progressEl.releasePointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      this.hideScrub();
      this.cb.onSeekFraction(fraction);
    };
    this.progressEl.addEventListener('pointerup', finish);
    this.progressEl.addEventListener('pointercancel', (e) => {
      this.dragFraction = null;
      this.progressEl.classList.remove('dragging');
      this.hideScrub();
      void e;
    });
    this.progressEl.addEventListener('pointerleave', () => {
      if (this.dragFraction == null) this.hideScrub();
    });
  }

  /** The "sentence 42 of 310" bubble that follows the pointer along the scrubber. */
  private renderScrub(clientX: number): void {
    const total = this.lastState?.totalChunks ?? 0;
    if (!total) return;
    const bar = this.bar.getBoundingClientRect();
    const track = this.progressEl.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - track.left) / track.width));
    const sentence = Math.min(total, Math.floor(fraction * total) + 1);
    this.scrubEl.textContent = `Sentence ${sentence} of ${total}`;
    // Positioned against the bar (the scrub bubble's offset parent), and kept inside it so the
    // bubble never hangs off the edge of the screen on a narrow viewport.
    const x = Math.min(Math.max(clientX - bar.left, 44), bar.width - 44);
    this.scrubEl.style.left = `${Math.round(x)}px`;
    this.scrubEl.hidden = false;
    if (this.dragFraction != null) this.paintProgress(this.dragFraction * 100);
  }

  private hideScrub(): void {
    this.scrubEl.hidden = true;
    if (this.lastState) this.renderProgress(this.lastState);
  }

  // ---- keyboard ------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    // Let the <select>s handle their own keys — arrows change their value.
    if (e.target instanceof HTMLSelectElement) return;
    const onButton = e.target instanceof HTMLButtonElement;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
      case 'k':
        // A focused button handles Space itself; anywhere else in the bar it is play/pause.
        if (onButton && e.key !== 'k') return;
        e.preventDefault();
        if (this.playing) this.cb.onPause();
        else this.cb.onPlay();
        return;
      case 'Enter':
        return; // focused button handles it
      case 'b':
        e.preventDefault();
        this.cb.onBackALittle();
        return;
      case 'n':
        e.preventDefault();
        this.cb.onSaveNote();
        return;
      case 'ArrowLeft':
      case 'j':
        e.preventDefault();
        this.cb.onPrev();
        return;
      case 'ArrowRight':
      case 'l':
        e.preventDefault();
        this.cb.onNext();
        return;
      case 'ArrowUp':
        e.preventDefault();
        this.nudgeSpeed(1);
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.nudgeSpeed(-1);
        return;
      case 'Home':
        e.preventDefault();
        this.cb.onSeekFraction(0);
        return;
      case 'End':
        e.preventDefault();
        this.cb.onSeekFraction(0.999);
        return;
      default:
    }
  }

  private nudgeSpeed(direction: 1 | -1): void {
    const i = SPEEDS.indexOf(this.currentSpeed);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + direction))];
    if (next == null || next === this.currentSpeed) return;
    this.currentSpeed = next;
    this.speedEl.value = String(next);
    this.cb.onSpeed(next);
  }

  // ---- public API ----------------------------------------------------------

  /** Populate the in-bar voice picker. Pass an empty list to hide it. */
  /**
   * The voice picker: every downloaded voice, from every engine, grouped "Engine · language".
   * `current` is an `engine:voice` value (see shared/voice-catalog.ts); picking a voice of another
   * engine switches engine, which the session handles like any voice change.
   */
  setVoices(voices: EngineVoice[], current: string, opts: { downloadedOnly?: boolean } = {}): void {
    if (!voices.length) {
      this.voiceEl.hidden = true;
      return;
    }

    // The bar is narrow: "Alba · medium" was cut to "Alba · mediu…". Just the name, then — with the
    // quality or gender kept only where two voices on the list share a name (Alba medium and Alba
    // high), and the whole label in the tooltip.
    const nameOf = (v: EngineVoice): string => v.label.split(' · ')[0] ?? v.label;
    const named = new Map<string, number>();
    for (const v of voices) named.set(`${v.engine}:${nameOf(v)}`, (named.get(`${v.engine}:${nameOf(v)}`) ?? 0) + 1);
    const option = (v: EngineVoice): HTMLOptionElement => {
      const value = voiceValue(v.engine, v.id);
      const shared = (named.get(`${v.engine}:${nameOf(v)}`) ?? 0) > 1;
      const o = this.make('option', { value, title: v.label }, shared ? v.label : nameOf(v));
      if (value === current) o.selected = true;
      return o;
    };

    const groups: HTMLElement[] = [];
    for (const engine of ENGINE_IDS) {
      const ofEngine = voices.filter((v) => v.engine === engine);
      if (!ofEngine.length) continue;
      const name = engineInfo(engine).name;
      for (const [language, items] of groupByLanguage(ofEngine)) {
        const group = this.make('optgroup', { label: language ? `${name} · ${readableLanguage(language)}` : name });
        group.append(...items.map((v) => option(v as EngineVoice)));
        groups.push(group);
      }
    }

    this.voiceEl.replaceChildren(
      ...groups,
      // Says what the list is, in the list. The bar offers only voices already on the device —
      // choosing one here should never start a 60 MB download in the middle of an article — and
      // a picker that silently holds back most of the catalogue owes the reader that sentence.
      ...(opts.downloadedOnly
        ? [this.make('option', { value: '', disabled: '' }, '— downloaded voices · add more in Settings —')]
        : []),
    );
    this.voiceEl.value = current;
    this.voiceEl.title = opts.downloadedOnly
      ? 'Voice — every voice downloaded to this device, from any engine. Add more in Settings.'
      : 'Voice';
    this.voiceEl.hidden = false;
  }

  /** Sync the in-bar toggle when the setting was changed elsewhere (e.g. the options page). */
  setTapToSeek(on: boolean): void {
    if (this.tapToSeek === on) return;
    this.tapToSeek = on;
    this.reflectTapToSeek();
  }

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    this.speedEl.value = String(speed);
  }

  /**
   * Words a minute, beside the speed. "1.5×" says how far the slider moved; this says whether
   * that is an audiobook (about 155) or faster than most people can follow (past 400). Null
   * while nothing has been measured and no estimate is known.
   */
  setReadingRate(wpm: number | null): void {
    this.rateEl.hidden = wpm == null;
    this.rateEl.textContent = wpm == null ? '' : `${wpm} wpm`;
  }

  setTheme(theme: ThemeChoice): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.applyTheme();
  }

  /**
   * Light the snap button up while the sentence being read is off screen.
   *
   * This is the only control that advertises itself, and deliberately: someone who has scrolled
   * away to look at something else has no other cue that Aloud can take them back.
   */
  setCurrentOffScreen(offScreen: boolean): void {
    this.snapBtn.classList.toggle('offscreen', offScreen);
    this.snapBtn.title = offScreen
      ? 'The sentence being read is off screen — click to scroll back to it'
      : 'Scroll to the sentence being read';
  }

  /**
   * Show a short confirmation ("Speed 1.5×", "Jumped to sentence 42") for a moment, then hand
   * the status pill back to whatever the session is reporting.
   *
   * Errors are never overwritten by a flash: a message the user must act on outranks one that
   * only confirms what they already did.
   */
  flash(text: string, kind: 'info' | 'ok' = 'info', action?: FlashAction): void {
    if (this.lastState?.status === 'error') return;
    // A message is an answer to something you just did: show the bar it appears on.
    this.setTucked(false);
    this.flashing = true;
    // Shown even while the tips card is up: status can wait, but "Saved to Notes" is the answer
    // to something the reader just did, and silence would read as the button not working.
    this.setToast(text, false, kind === 'ok' ? 'ok' : null, true);
    const dismiss = (): void => {
      clearTimeout(this.flashTimer);
      this.flashing = false;
      if (this.tips) this.clearToast();
      else if (this.lastState) this.renderToast(this.lastState);
      else this.clearToast();
    };
    if (action) {
      // A flash that offers a choice has to stay long enough to be taken.
      const btn = this.make('button', { class: 'toast-action', type: 'button' }, action.label);
      btn.addEventListener('click', () => {
        dismiss();
        action.run();
      });
      this.toast.appendChild(btn);
    }
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(dismiss, action ? FLASH_ACTION_MS : FLASH_MS) as unknown as number;
  }

  update(state: SessionState): void {
    this.lastState = state;
    this.playing = state.status === 'playing';
    // Paused, stopped or loading: the bar is what you reach for next.
    if (!this.playing) this.setTucked(false);
    this.renderPlayButton(state);
    this.renderProgress(state);
    if (!this.flashing || state.status === 'error') {
      this.flashing = false;
      this.renderToast(state);
    }

    const settingUp = state.status === 'extracting' || state.status === 'loading-model';
    this.prevBtn.disabled = settingUp;
    this.nextBtn.disabled = settingUp;
    this.snapBtn.disabled = settingUp || state.totalChunks === 0;
  }

  focus(): void {
    try {
      this.bar.focus({ preventScroll: true });
    } catch {
      /* the bar may already be gone */
    }
  }

  dispose(): void {
    for (const off of this.offWindow) off();
    this.offWindow.length = 0;
    clearTimeout(this.flashTimer);
    this.closePopover();
    this.unwatchTheme();
    this.host.remove();
  }

  // ---- sleep timer ---------------------------------------------------------

  /** Reflect the session's sleep timer on the moon button: lit, with "12m", "¶" or "§". */
  setSleep(state: SleepState): void {
    this.sleepState = state;
    const on = state.choice !== 'off';
    this.sleepBtn.classList.toggle('on', on);
    this.sleepBadge.hidden = !on;
    this.sleepBadge.textContent = state.badge;
    this.sleepBtn.title = on ? `Sleep timer: ${SLEEP_LABEL.get(state.choice) ?? 'on'}` : 'Sleep timer';
  }

  private toggleSleepMenu(): void {
    if (this.popover?.button === this.sleepBtn) {
      this.closePopover();
      return;
    }
    const menu = this.make('div', { class: 'pop-menu', role: 'menu', 'aria-label': 'Sleep timer' });
    menu.appendChild(this.make('div', { class: 'menu-title' }, 'Stop reading'));
    for (const [choice, label] of SLEEP_LABEL) {
      const checked = this.sleepState.choice === choice;
      const option = this.make(
        'button',
        { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), class: checked ? 'is-checked' : '' },
        label,
      );
      option.addEventListener('click', () => {
        this.closePopover();
        this.cb.onSleep(choice);
      });
      menu.appendChild(option);
    }
    this.openPopover(this.sleepBtn, menu);
    menu.querySelector<HTMLButtonElement>('button[aria-checked="true"], button')?.focus({ preventScroll: true });
  }

  // ---- save as MP3 ---------------------------------------------------------

  /** Reflect the export on the save button, and in its menu if that is open. */
  setExport(state: ExportState): void {
    this.exportState = state;
    this.saveBtn.classList.toggle('on', state.phase === 'running' || state.phase === 'done');
    // Progress stays in sight with the menu closed: a percentage while it runs, a tick when ready.
    const running = state.phase === 'running';
    this.saveBadge.hidden = !running && state.phase !== 'done';
    this.saveBadge.textContent = running ? `${percent(state.done, state.total)}%` : '✓';
    this.saveBtn.title = running ? 'Making the MP3…' : state.phase === 'done' ? 'MP3 ready to save' : 'Save as MP3';
    const body = this.popover?.button === this.saveBtn ? this.popover.menu : null;
    if (body) this.renderExportMenu(body);
  }

  private toggleExportMenu(): void {
    if (this.popover?.button === this.saveBtn) {
      this.closePopover();
      return;
    }
    const menu = this.make('div', { class: 'pop-menu export-menu', role: 'dialog', 'aria-label': 'Save as MP3' });
    this.renderExportMenu(menu);
    this.openPopover(this.saveBtn, menu);
    menu.querySelector<HTMLButtonElement>('button.primary, button')?.focus({ preventScroll: true });
  }

  private renderExportMenu(menu: HTMLElement): void {
    const state = this.exportState;
    const hadFocus = this.root.activeElement instanceof HTMLElement && menu.contains(this.root.activeElement);
    menu.replaceChildren(this.make('div', { class: 'menu-title' }, 'Save as MP3'));
    const text = (t: string, cls = 'menu-text'): void => void menu.appendChild(this.make('p', { class: cls }, t));
    const action = (label: string, run: () => void, primary = false): HTMLButtonElement => {
      const b = this.make('button', { type: 'button', class: primary ? 'primary' : '' }, label);
      b.addEventListener('click', run);
      menu.appendChild(b);
      return b;
    };

    switch (state.phase) {
      case 'idle':
        text('The whole document, in this voice and at this speed, as one audio file. Reading pauses while it is made.');
        action('Make the MP3', () => this.cb.onExportStart(), true);
        break;
      case 'running': {
        const pct = percent(state.done, state.total);
        text(`${state.done} of ${state.total} sentences`);
        const meter = this.make('div', {
          class: 'meter',
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(pct),
        });
        const fill = this.make('i');
        fill.style.width = `${pct}%`;
        meter.appendChild(fill);
        menu.appendChild(meter);
        action('Cancel', () => this.cb.onExportCancel());
        break;
      }
      case 'done':
        text(`${formatDuration(state.seconds)} of audio · ${formatBytes(state.bytes)}`);
        action('Save file', () => {
          this.cb.onExportSave();
          this.closePopover();
        }, true);
        action('Discard', () => this.cb.onExportCancel());
        break;
      case 'error':
        text(state.message, 'menu-text error');
        action('Try again', () => this.cb.onExportStart(), true);
        break;
    }
    if (hadFocus) menu.querySelector<HTMLButtonElement>('button.primary, button')?.focus({ preventScroll: true });
  }

  // ---- popovers ------------------------------------------------------------

  /** Show `menu` directly above the bar, below any status pill, until dismissed. */
  private openPopover(button: HTMLButtonElement, menu: HTMLElement): void {
    this.closePopover();
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closePopover();
        button.focus({ preventScroll: true });
      }
    });
    this.dock.insertBefore(menu, this.bar);
    button.setAttribute('aria-expanded', 'true');

    // A press anywhere else closes it. Two listeners, because neither can see everything: our
    // shadow root is closed, so a document listener sees a press on the menu only as a press on
    // the host element — it must leave those to the root listener, which can see *where* inside
    // the bar the press landed. (Treating "host" as "outside" closed the menu on pointerdown,
    // before the click on an option could ever fire.)
    const page = (e: Event): void => {
      if (e.composedPath().includes(this.host)) return;
      this.closePopover();
    };
    const bar = (e: Event): void => {
      const path = e.composedPath();
      if (path.includes(menu) || path.includes(button)) return;
      this.closePopover();
    };
    this.popover = { menu, button, page, bar };
    this.doc.addEventListener('pointerdown', page, true);
    this.root.addEventListener('pointerdown', bar, true);
  }

  private closePopover(): void {
    const open = this.popover;
    if (!open) return;
    this.popover = null;
    this.doc.removeEventListener('pointerdown', open.page, true);
    this.root.removeEventListener('pointerdown', open.bar, true);
    open.menu.remove();
    open.button.setAttribute('aria-expanded', 'false');
  }

  // ---- first-run tips ------------------------------------------------------

  /**
   * The one-time card above the bar that explains the controls.
   *
   * It is shown once per profile, on the first page anyone reads, because the bar is a row of
   * unlabelled icons the first time you meet it: this says what they do, in place, at the moment
   * they appear. `onTipsDismissed` persists the dismissal; "How Aloud works" opens the full
   * walkthrough for anyone who wants more than five lines.
   */
  showTips(): void {
    if (this.tips) return;

    const card = this.make('div', { class: 'tips', role: 'dialog', 'aria-label': 'How to use Aloud' });
    card.appendChild(this.make('h2', {}, 'Aloud is reading this page'));

    const list = this.make('ul');
    // The marks are the bar's own icons, not lookalike characters: the card is teaching which
    // button does what, so it has to show the button.
    const tip = (mark: string | readonly string[], strong: string, rest: string): HTMLElement => {
      const li = this.make('li');
      const key = this.make('span', { class: 'key' });
      if (typeof mark === 'string') key.textContent = mark;
      else key.appendChild(svgIcon(this.doc, [...mark], 13));
      li.append(key);
      const text = this.make('span', { class: 'tip-text' });
      text.append(this.make('b', {}, strong), this.doc.createTextNode(` ${rest}`));
      li.append(text);
      return li;
    };
    list.append(
      tip('Space', 'Play or pause.', 'Arrow keys step a sentence at a time.'),
      tip(ICON_PATHS.target, 'Click any sentence', 'in the page to jump straight to it.'),
      tip(ICON_PATHS.snap, 'Lost your place?', 'This scrolls back to what is being read.'),
      tip(ICON_PATHS.gear, 'Voices, speed and theme', 'live in the settings page.'),
    );
    card.appendChild(list);

    const actions = this.make('div', { class: 'tips-actions' });
    const got = this.make('button', { class: 'ok', type: 'button' }, 'Got it');
    const more = this.make('button', { class: 'link', type: 'button' }, 'How Aloud works');
    got.addEventListener('click', () => this.dismissTips());
    more.addEventListener('click', () => {
      this.dismissTips();
      this.cb.onOpenWalkthrough();
    });
    actions.append(got, more);
    card.appendChild(actions);

    this.tips = card;
    // The card is the top of the dock's column, above the status pill — which is hidden while
    // the card is up, so the two never say different things in the same place.
    this.toast.hidden = true;
    this.dock.prepend(card);
    got.focus({ preventScroll: true });
  }

  private dismissTips(): void {
    this.tips?.remove();
    this.tips = null;
    this.cb.onTipsDismissed();
    if (this.lastState) this.renderToast(this.lastState);
  }

  /**
   * Put the tips card away without counting it as read — for when the bar has something more
   * important to say (a voice producing no audio) than how its buttons work.
   */
  hideTips(): void {
    if (!this.tips) return;
    this.tips.remove();
    this.tips = null;
    if (this.lastState && !this.flashing) this.renderToast(this.lastState);
  }

  // ---- rendering -----------------------------------------------------------

  private applyTheme(): void {
    const resolved = resolveTheme(this.theme, this.doc.defaultView);
    this.host.dataset.theme = resolved;
    // `color-scheme` decides the palette of the browser's own widgets — above all the popup a
    // native <select> opens, which otherwise uses the OS palette while inheriting our text colour
    // (light-on-light in a dark bar). It has to be set *inline*: the host's inline `all: initial`
    // outranks any `:host` rule in the shadow stylesheet, so a CSS declaration there never applied
    // (measured: computed color-scheme stayed "normal").
    this.host.style.colorScheme = resolved;
  }

  /**
   * The play button has three states: play (resting), pause (playing), and a spinner while
   * there is nothing to play yet — extracting, loading the voice, or re-buffering mid-article.
   */
  private renderPlayButton(state: SessionState): void {
    const loading =
      state.status === 'loading-model' ||
      state.status === 'extracting' ||
      (state.busy === true && state.status !== 'error');
    const mode: PlayMode = loading ? 'loading' : this.playing ? 'pause' : 'play';

    if (mode !== this.playBtnMode) {
      this.playBtnMode = mode;
      if (mode === 'loading') {
        this.playBtn.replaceChildren(this.make('span', { class: 'btn-spin' }));
      } else {
        this.playBtn.replaceChildren(
          svgIcon(this.doc, [...(mode === 'pause' ? ICON_PATHS.pause : ICON_PATHS.play)]),
        );
      }
    }

    this.playBtn.classList.toggle('loading', loading);
    this.playBtn.setAttribute('aria-busy', String(loading));
    this.playBtn.setAttribute('aria-label', loading ? 'Loading' : this.playing ? 'Pause' : 'Play');
    // Pulse when we wanted to play but the browser wants a click first.
    this.playBtn.classList.toggle('attn', Boolean(state.hint) && !this.playing && !loading);
  }

  private renderProgress(state: SessionState): void {
    const total = state.totalChunks || 0;
    const current = Math.min(state.currentIndex + 1, total);
    this.countEl.textContent = total ? `${current}/${total}` : '–/–';
    if (this.dragFraction != null) return; // the pointer owns the fill mid-drag

    const percent = total ? (state.currentIndex / total) * 100 : 0;
    this.paintProgress(percent);
    this.progressEl.setAttribute('aria-valuenow', String(Math.round(percent)));
    this.progressEl.setAttribute(
      'aria-valuetext',
      total ? `Sentence ${current} of ${total}` : 'Nothing to read yet',
    );
  }

  private paintProgress(percent: number): void {
    this.fillEl.style.width = `${percent}%`;
    this.knobEl.style.left = `${percent}%`;
  }

  private renderToast(state: SessionState): void {
    // While the tips card is up it *is* the message above the bar.
    if (this.tips) return;
    const engine = state.engineInfo ? ` · ${state.engineInfo}` : '';

    if (state.status === 'error') {
      this.setToast(state.error ?? 'Something went wrong', false, 'err');
    } else if (state.status === 'extracting') {
      this.setToast('Reading page…', true);
    } else if (state.status === 'loading-model') {
      this.setToast(
        state.modelProgress > 0
          ? `Loading voice… ${Math.round(state.modelProgress * 100)}%`
          : 'Loading voice…',
        true,
      );
    } else if (state.busy) {
      this.setToast(`Buffering…${engine}`, true);
    } else if (state.hint) {
      this.setToast(state.hint, false);
    } else {
      this.clearToast();
    }
  }

  private setToast(text: string, spinner: boolean, kind: 'err' | 'ok' | null = null, overTips = false): void {
    if (this.tips && !overTips) return;
    this.toast.className = kind ? `toast ${kind}` : 'toast';
    const children: Node[] = [];
    if (spinner) children.push(this.make('span', { class: 'spinner' }));
    children.push(this.doc.createTextNode(text));
    this.toast.replaceChildren(...children);
    this.toast.hidden = false;
  }

  private clearToast(): void {
    this.toast.hidden = true;
    this.toast.replaceChildren();
  }

  private reflectTapToSeek(): void {
    this.tapBtn.classList.toggle('on', this.tapToSeek);
    this.tapBtn.setAttribute('aria-pressed', String(this.tapToSeek));
    this.tapBtn.title = this.tapToSeek
      ? 'Click-to-jump is ON — click a sentence in the page to jump there'
      : 'Click-to-jump is OFF';
  }
}

function percent(done: number, total: number): number {
  return total ? Math.floor((100 * done) / total) : 0;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min ${sec} s` : `${sec} s`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** "en-GB" -> "British English"; names that are already words pass through. */
function readableLanguage(label: string): string {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(label)) return label;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(label) ?? label;
  } catch {
    return label;
  }
}
