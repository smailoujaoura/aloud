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
 */
import { el, svgIcon } from '@/shared/dom';
import { groupByLanguage, type VoiceOption } from '@/shared/voice-catalog';
import type { SessionState } from '@/shared/messages';
import { CONTROL_BAR_CSS } from './control-bar-styles';
import { ICON_PATHS } from './icons';

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
  onOpenSettings(): void;
  onClose(): void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];

/** Shadow host id. `content/tap-to-seek` uses it to ignore clicks landing on our own UI. */
export const CONTROL_HOST_ID = 'aloud-control-host';

/** What the play button is showing. */
type PlayMode = 'play' | 'pause' | 'loading';

export class ControlBar {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;

  private bar!: HTMLDivElement;
  private toast!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private tapBtn!: HTMLButtonElement;
  private progressEl!: HTMLDivElement;
  private fillEl!: HTMLElement;
  private countEl!: HTMLElement;
  private speedEl!: HTMLSelectElement;
  private voiceEl!: HTMLSelectElement;

  private playing = false;
  private currentSpeed: number;
  private tapToSeek: boolean;
  /** Last rendered play-button mode, so `update()` only rebuilds it on a real change — otherwise
   *  the loading spinner's animation restarts on every state push. */
  private playBtnMode: PlayMode | null = null;

  constructor(
    private readonly doc: Document,
    private readonly cb: ControlBarCallbacks,
    speed: number,
    tapToSeek = false,
  ) {
    this.currentSpeed = speed;
    this.tapToSeek = tapToSeek;

    this.host = doc.createElement('div');
    this.host.id = CONTROL_HOST_ID;
    this.host.style.cssText = 'all: initial; position: static;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    (doc.documentElement ?? doc.body).appendChild(this.host);

    this.build(speed);
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

    this.bar = this.make('div', {
      class: 'bar',
      role: 'group',
      tabindex: '0',
      'aria-label': 'Aloud playback controls',
    });

    this.toast = this.make('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: '' });

    this.playBtn = this.iconButton('play', 'Play', ICON_PATHS.play);
    this.prevBtn = this.iconButton('prev', 'Previous sentence', ICON_PATHS.prev, 'Previous (←)');
    this.nextBtn = this.iconButton('next', 'Next sentence', ICON_PATHS.next, 'Next (→)');
    this.tapBtn = this.iconButton('tap', 'Click a sentence to jump there', ICON_PATHS.target);
    const gearBtn = this.iconButton('gear', 'Settings', ICON_PATHS.gear, 'Settings');
    const closeBtn = this.iconButton('close', 'Close', ICON_PATHS.close, 'Close');

    this.progressEl = this.make('div', {
      class: 'progress',
      role: 'slider',
      'aria-label': 'Progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    });
    this.fillEl = this.make('i');
    this.progressEl.appendChild(this.fillEl);

    this.countEl = this.make('span', { class: 'count' }, '–/–');

    this.speedEl = this.make('select', { class: 'speed', 'aria-label': 'Speed', title: 'Speed (↑ / ↓)' });
    for (const s of SPEEDS) {
      const opt = this.make('option', { value: String(s) }, `${s}×`);
      if (s === speed) opt.selected = true;
      this.speedEl.appendChild(opt);
    }

    this.voiceEl = this.make('select', { class: 'voice', 'aria-label': 'Voice', hidden: '' });
    this.reflectTapToSeek();

    this.bar.append(
      this.playBtn,
      this.prevBtn,
      this.nextBtn,
      this.progressEl,
      this.countEl,
      // Only takes up space in the two-row narrow layout, where the progress bar has moved to
      // its own row and the transport controls would otherwise stretch across the whole width.
      this.make('span', { class: 'spacer' }),
      this.speedEl,
      this.voiceEl,
      this.tapBtn,
      gearBtn,
      closeBtn,
    );
    this.root.append(style, this.toast, this.bar);

    this.playBtn.addEventListener('click', () => (this.playing ? this.cb.onPause() : this.cb.onPlay()));
    this.prevBtn.addEventListener('click', () => this.cb.onPrev());
    this.nextBtn.addEventListener('click', () => this.cb.onNext());
    this.tapBtn.addEventListener('click', () => {
      this.tapToSeek = !this.tapToSeek;
      this.reflectTapToSeek();
      this.cb.onToggleTapToSeek(this.tapToSeek);
    });
    this.speedEl.addEventListener('change', () => this.cb.onSpeed(Number(this.speedEl.value)));
    this.voiceEl.addEventListener('change', () => this.cb.onVoice(this.voiceEl.value));
    gearBtn.addEventListener('click', () => this.cb.onOpenSettings());
    closeBtn.addEventListener('click', () => this.cb.onClose());
    this.progressEl.addEventListener('click', (e) => {
      const r = this.progressEl.getBoundingClientRect();
      this.cb.onSeekFraction(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
    });

    this.bar.addEventListener('keydown', (e) => this.onKey(e));
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

  update(state: SessionState): void {
    this.playing = state.status === 'playing';
    this.renderPlayButton(state);
    this.renderProgress(state);
    this.renderToast(state);

    const settingUp = state.status === 'extracting' || state.status === 'loading-model';
    this.prevBtn.disabled = settingUp;
    this.nextBtn.disabled = settingUp;
  }

  focus(): void {
    try {
      this.bar.focus({ preventScroll: true });
    } catch {
      /* the bar may already be gone */
    }
  }

  dispose(): void {
    this.host.remove();
  }

  // ---- rendering -----------------------------------------------------------

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

    const percent = total ? (state.currentIndex / total) * 100 : 0;
    this.fillEl.style.width = `${percent}%`;
    this.progressEl.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  private renderToast(state: SessionState): void {
    const engine = state.engineInfo ? ` · ${state.engineInfo}` : '';

    if (state.status === 'error') {
      this.setToast(state.error ?? 'Something went wrong', false, true);
    } else if (state.status === 'extracting') {
      this.setToast('Reading page…', true);
    } else if (state.status === 'loading-model') {
      this.setToast(`Loading voice… ${Math.round(state.modelProgress * 100)}%`, true);
    } else if (state.busy) {
      this.setToast(`Buffering…${engine}`, true);
    } else if (state.hint) {
      this.setToast(state.hint, false);
    } else {
      this.toast.hidden = true;
      this.toast.replaceChildren();
    }
  }

  private setToast(text: string, spinner: boolean, isError = false): void {
    this.toast.className = isError ? 'toast err' : 'toast';
    const children: Node[] = [];
    if (spinner) children.push(this.make('span', { class: 'spinner' }));
    children.push(this.doc.createTextNode(text));
    this.toast.replaceChildren(...children);
    this.toast.hidden = false;
  }

  private reflectTapToSeek(): void {
    this.tapBtn.classList.toggle('on', this.tapToSeek);
    this.tapBtn.setAttribute('aria-pressed', String(this.tapToSeek));
    this.tapBtn.title = this.tapToSeek
      ? 'Click-to-jump is ON — click a sentence in the page to jump there'
      : 'Click-to-jump is OFF';
  }
}
