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
import { groupByLanguage, type VoiceOption } from '@/shared/voice-catalog';
import type { SessionState } from '@/shared/messages';
import type { ThemeChoice } from '@/shared/settings';
import { CONTROL_BAR_CSS } from './control-bar-styles';
import { ICON_PATHS } from './icons';
import { resolveTheme, watchSystemTheme } from './theme';

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
  private voiceEl!: HTMLSelectElement;

  private playing = false;
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
    this.snapBtn = this.iconButton(
      'snap',
      'Scroll to the sentence being read',
      ICON_PATHS.snap,
      'Scroll to the sentence being read',
    );
    this.tapBtn = this.iconButton('tap', 'Click a sentence to jump there', ICON_PATHS.target);
    const gearBtn = this.iconButton('gear', 'Settings', ICON_PATHS.gear, 'Voices, speed and theme');
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
    side.append(this.snapBtn, this.tapBtn, gearBtn, closeBtn);

    this.bar.append(
      this.playBtn,
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
  setVoices(voices: VoiceOption[], current: string): void {
    if (!voices.length) {
      this.voiceEl.hidden = true;
      return;
    }

    const option = (v: VoiceOption): HTMLOptionElement => {
      const o = this.make('option', { value: v.id }, v.label);
      if (v.id === current) o.selected = true;
      return o;
    };

    this.voiceEl.replaceChildren(
      ...groupByLanguage(voices).map(([language, items]) => {
        const group = this.make('optgroup', { label: language });
        group.append(...items.map(option));
        return group;
      }),
    );
    this.voiceEl.value = current;
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
    this.flashing = true;
    this.setToast(text, false, kind === 'ok' ? 'ok' : null);
    const dismiss = (): void => {
      clearTimeout(this.flashTimer);
      this.flashing = false;
      if (this.lastState) this.renderToast(this.lastState);
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
    clearTimeout(this.flashTimer);
    this.unwatchTheme();
    this.host.remove();
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

  private setToast(text: string, spinner: boolean, kind: 'err' | 'ok' | null = null): void {
    if (this.tips) return;
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
