/**
 * The in-page playback control bar. Rendered inside a Shadow DOM attached to `<html>` so the
 * host page's CSS can never touch it and vice-versa. DOM is built with createElement (no
 * innerHTML) so it passes `web-ext lint` cleanly.
 *
 * Layout is a fixed width (a function of viewport width only) so buttons never shift when the
 * status text changes — transient status ("Loading…", "Buffering…", errors) is shown in a
 * separate pill floated above the bar, which does not participate in the bar's flow.
 */
import type { SessionState } from '@/shared/messages';

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

const CSS = `
:host { all: initial; }
.bar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  z-index: 2147483647;
  box-sizing: border-box;
  width: min(760px, calc(100vw - 20px));
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 14px;
  background: #1c1c22; color: #f2f2f5;
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 8px 30px rgba(0,0,0,.35);
}
.bar:focus-visible { outline: 2px solid #ffd60a; outline-offset: 2px; }
button {
  all: unset; box-sizing: border-box; flex: 0 0 auto;
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 8px; color: inherit;
}
button:hover { background: rgba(255,255,255,.12); }
button:focus-visible { outline: 2px solid #ffd60a; outline-offset: 1px; }
button[disabled] { opacity: .4; cursor: default; }
.play { width: 34px; height: 34px; background: #ffd60a; color: #1c1c22; font-weight: 700; }
.play:hover { background: #ffe14d; }
.play.attn { animation: aloud-pulse 1.4s ease-in-out infinite; }
.play.loading { cursor: progress; }
.play.loading:hover { background: #ffd60a; }
.play .btn-spin {
  width: 16px; height: 16px; box-sizing: border-box;
  border: 2px solid rgba(28,28,34,.3); border-top-color: #1c1c22;
  border-radius: 50%; animation: aloud-spin .8s linear infinite;
}
.tap.on { background: #ffd60a; color: #1c1c22; }
.tap.on:hover { background: #ffe14d; }
@keyframes aloud-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,214,10,.6); } 50% { box-shadow: 0 0 0 6px rgba(255,214,10,0); } }
.progress {
  flex: 1 1 auto; min-width: 40px; height: 6px; border-radius: 3px;
  background: rgba(255,255,255,.18); cursor: pointer; position: relative;
}
.progress > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: #ffd60a; width: 0%; }
.count { flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: .7; white-space: nowrap; }
select {
  all: unset; box-sizing: border-box; flex: 0 0 auto;
  cursor: pointer; padding: 3px 6px; border-radius: 7px;
  background: rgba(255,255,255,.12); color: inherit; font: inherit;
  max-width: 120px; text-overflow: ellipsis;
}
select:focus-visible { outline: 2px solid #ffd60a; }
.voice[hidden] { display: none; }
.toast {
  position: absolute; left: 4px; right: 4px; bottom: calc(100% + 8px);
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 6px 12px; border-radius: 10px;
  background: #1c1c22; color: #f2f2f5;
  font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 22px rgba(0,0,0,.3);
  text-align: center;
}
.toast[hidden] { display: none; }
.toast.err { color: #ff8a8a; }
.spinner {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: 2px solid rgba(255,255,255,.3); border-top-color: #ffd60a;
  border-radius: 50%; animation: aloud-spin .8s linear infinite;
}
@keyframes aloud-spin { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: light) {
  .bar, .toast { background: #fff; color: #1c1c22; box-shadow: 0 8px 30px rgba(0,0,0,.18); border: 1px solid rgba(0,0,0,.08); }
  button:hover { background: rgba(0,0,0,.06); }
  .progress { background: rgba(0,0,0,.12); }
  select { background: rgba(0,0,0,.06); }
}
@media (prefers-reduced-motion: reduce) {
  .spinner, .play .btn-spin { animation-duration: 2s; }
  .play.attn { animation: none; box-shadow: 0 0 0 3px rgba(255,214,10,.5); }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

/** Build an inline SVG icon without innerHTML. */
function icon(doc: Document, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  for (const d of paths) {
    const p = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const ICON_PATHS = {
  play: ['M4 2.5v11l9-5.5z'],
  pause: ['M4 2.5h3v11H4z', 'M9 2.5h3v11H9z'],
  prev: ['M5 2.5v11H3.5v-11z', 'M13 2.5v11l-7-5.5z'],
  next: ['M11 2.5v11h1.5v-11z', 'M3 2.5v11l7-5.5z'],
  gear: ['M8 5a3 3 0 100 6 3 3 0 000-6zm6 3a6 6 0 01-.1 1l1.7 1.3-1.6 2.8-2-.8a6 6 0 01-1.7 1l-.3 2.1H6.3L6 15.6a6 6 0 01-1.7-1l-2 .8L.7 12.6 2.4 11a6 6 0 010-2L.7 7.7l1.6-2.8 2 .8A6 6 0 016 2.7L6.3.6h3.4l.3 2.1a6 6 0 011.7 1l2-.8 1.6 2.8L13.9 7q.1.5.1 1z'],
  close: ['M4 3l4 4 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z'],
  // Crosshair — "click a sentence to jump there".
  target: [
    'M8 0a1 1 0 011 1v1.06A6 6 0 0113.94 7H15a1 1 0 010 2h-1.06A6 6 0 019 13.94V15a1 1 0 01-2 0v-1.06A6 6 0 012.06 9H1a1 1 0 010-2h1.06A6 6 0 017 2.06V1a1 1 0 011-1zm0 4a4 4 0 100 8 4 4 0 000-8z',
    'M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  ],
};

export class ControlBar {
  private host: HTMLElement;
  private root: ShadowRoot;
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
  /** What the play button currently shows, so `update()` only swaps its contents on a change. */
  private playBtnMode: 'play' | 'pause' | 'loading' | null = null;

  constructor(
    private readonly doc: Document,
    private readonly cb: ControlBarCallbacks,
    speed: number,
    tapToSeek = false,
  ) {
    this.currentSpeed = speed;
    this.tapToSeek = tapToSeek;
    this.host = doc.createElement('div');
    this.host.id = 'aloud-control-host';
    this.host.style.cssText = 'all: initial; position: static;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    (doc.documentElement ?? doc.body).appendChild(this.host);
    this.build(speed);
  }

  private build(speed: number): void {
    const style = this.doc.createElement('style');
    style.textContent = CSS;

    this.bar = el(this.doc, 'div', {
      class: 'bar',
      role: 'group',
      tabindex: '0',
      'aria-label': 'Aloud playback controls',
    });

    this.toast = el(this.doc, 'div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: '' });

    this.playBtn = el(this.doc, 'button', { class: 'play', 'aria-label': 'Play' });
    this.playBtn.appendChild(icon(this.doc, ICON_PATHS.play));
    this.prevBtn = el(this.doc, 'button', { class: 'prev', 'aria-label': 'Previous sentence', title: 'Previous (←)' });
    this.prevBtn.appendChild(icon(this.doc, ICON_PATHS.prev));
    this.nextBtn = el(this.doc, 'button', { class: 'next', 'aria-label': 'Next sentence', title: 'Next (→)' });
    this.nextBtn.appendChild(icon(this.doc, ICON_PATHS.next));

    this.progressEl = el(this.doc, 'div', {
      class: 'progress',
      role: 'slider',
      'aria-label': 'Progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
    });
    this.fillEl = el(this.doc, 'i');
    this.progressEl.appendChild(this.fillEl);

    this.countEl = el(this.doc, 'span', { class: 'count' }, '–/–');

    this.speedEl = el(this.doc, 'select', { class: 'speed', 'aria-label': 'Speed', title: 'Speed (↑ / ↓)' });
    for (const s of SPEEDS) {
      const opt = el(this.doc, 'option', { value: String(s) }, `${s}×`);
      if (s === speed) opt.selected = true;
      this.speedEl.appendChild(opt);
    }

    this.voiceEl = el(this.doc, 'select', { class: 'voice', 'aria-label': 'Voice', hidden: '' });

    this.tapBtn = el(this.doc, 'button', { class: 'tap', 'aria-label': 'Click a sentence to jump there' });
    this.tapBtn.appendChild(icon(this.doc, ICON_PATHS.target));
    this.reflectTapToSeek();

    const gearBtn = el(this.doc, 'button', { class: 'gear', 'aria-label': 'Settings', title: 'Settings' });
    gearBtn.appendChild(icon(this.doc, ICON_PATHS.gear));
    const closeBtn = el(this.doc, 'button', { class: 'close', 'aria-label': 'Close', title: 'Close' });
    closeBtn.appendChild(icon(this.doc, ICON_PATHS.close));

    this.bar.append(
      this.playBtn,
      this.prevBtn,
      this.nextBtn,
      this.progressEl,
      this.countEl,
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

  private onKey(e: KeyboardEvent): void {
    // Let the <select>s and buttons handle their own keys (arrows change a select's value;
    // Space/Enter activates a focused button).
    if (e.target instanceof HTMLSelectElement) return;
    const k = e.key;
    const onButton = e.target instanceof HTMLButtonElement;
    if ((k === ' ' || k === 'Spacebar' || k === 'k') && !onButton) {
      e.preventDefault();
      this.playing ? this.cb.onPause() : this.cb.onPlay();
    } else if (k === ' ' || k === 'Enter') {
      return; // focused button handles it
    } else if (k === 'ArrowLeft' || k === 'j') {
      e.preventDefault();
      this.cb.onPrev();
    } else if (k === 'ArrowRight' || k === 'l') {
      e.preventDefault();
      this.cb.onNext();
    } else if (k === 'ArrowUp') {
      e.preventDefault();
      this.nudgeSpeed(1);
    } else if (k === 'ArrowDown') {
      e.preventDefault();
      this.nudgeSpeed(-1);
    } else if (k === 'Home') {
      e.preventDefault();
      this.cb.onSeekFraction(0);
    } else if (k === 'End') {
      e.preventDefault();
      this.cb.onSeekFraction(0.999);
    }
  }

  private nudgeSpeed(dir: 1 | -1): void {
    const i = SPEEDS.indexOf(this.currentSpeed);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + dir))];
    if (next != null && next !== this.currentSpeed) {
      this.currentSpeed = next;
      this.speedEl.value = String(next);
      this.cb.onSpeed(next);
    }
  }

  private setIcon(btn: HTMLButtonElement, paths: string[]): void {
    btn.replaceChildren(icon(this.doc, paths));
  }

  /** Populate the in-bar voice picker. Pass an empty list to hide it. Groups become <optgroup>s. */
  setVoices(voices: Array<{ id: string; label: string; group?: string }>, current: string): void {
    if (!voices.length) {
      this.voiceEl.hidden = true;
      return;
    }
    const mkOption = (v: { id: string; label: string }): HTMLOptionElement => {
      const o = el(this.doc, 'option', { value: v.id }, v.label);
      if (v.id === current) o.selected = true;
      return o;
    };
    const grouped = voices.some((v) => v.group);
    if (!grouped) {
      this.voiceEl.replaceChildren(...voices.map(mkOption));
    } else {
      const byGroup = new Map<string, Array<{ id: string; label: string }>>();
      for (const v of voices) {
        const g = v.group ?? '';
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g)!.push(v);
      }
      const nodes: Node[] = [];
      for (const [g, items] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const og = el(this.doc, 'optgroup', { label: g || 'Other' });
        og.append(...items.map(mkOption));
        nodes.push(og);
      }
      this.voiceEl.replaceChildren(...nodes);
    }
    this.voiceEl.value = current;
    this.voiceEl.hidden = false;
  }

  /** Sync the in-bar toggle when the setting was changed elsewhere (e.g. the options page). */
  setTapToSeek(on: boolean): void {
    if (this.tapToSeek === on) return;
    this.tapToSeek = on;
    this.reflectTapToSeek();
  }

  private reflectTapToSeek(): void {
    this.tapBtn.classList.toggle('on', this.tapToSeek);
    this.tapBtn.setAttribute('aria-pressed', String(this.tapToSeek));
    this.tapBtn.title = this.tapToSeek
      ? 'Click-to-jump is ON — click a sentence in the page to jump there'
      : 'Click-to-jump is OFF';
  }

  update(state: SessionState): void {
    this.playing = state.status === 'playing';

    // The play button has three visual states: play (resting), pause (playing), and a spinner
    // (extracting / loading the voice / re-buffering mid-playback). Only swap its contents when
    // the state actually changes, so the spinner animation doesn't restart on every update.
    const loading =
      state.status === 'loading-model' ||
      state.status === 'extracting' ||
      (state.busy === true && state.status !== 'error');
    const mode: 'loading' | 'pause' | 'play' = loading ? 'loading' : this.playing ? 'pause' : 'play';
    if (mode !== this.playBtnMode) {
      this.playBtnMode = mode;
      if (mode === 'loading') {
        this.playBtn.replaceChildren(el(this.doc, 'span', { class: 'btn-spin' }));
      } else {
        this.setIcon(this.playBtn, mode === 'pause' ? ICON_PATHS.pause : ICON_PATHS.play);
      }
    }
    this.playBtn.classList.toggle('loading', loading);
    this.playBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    this.playBtn.setAttribute(
      'aria-label',
      loading ? 'Loading' : this.playing ? 'Pause' : 'Play',
    );
    this.playBtn.classList.toggle('attn', !!state.hint && !this.playing && !loading);

    const total = state.totalChunks || 0;
    const cur = Math.min(state.currentIndex + 1, total);
    this.countEl.textContent = total ? `${cur}/${total}` : '–/–';
    const frac = total ? (state.currentIndex / total) * 100 : 0;
    this.fillEl.style.width = `${frac}%`;
    this.progressEl.setAttribute('aria-valuenow', String(Math.round(frac)));

    const disabled = state.status === 'extracting' || state.status === 'loading-model';
    this.prevBtn.disabled = disabled;
    this.nextBtn.disabled = disabled;

    const eng = state.engineInfo ? ` · ${state.engineInfo}` : '';
    if (state.status === 'error') {
      this.setToast(state.error ?? 'Something went wrong', false, true);
    } else if (state.status === 'extracting') {
      this.setToast('Reading page…', true);
    } else if (state.status === 'loading-model') {
      this.setToast(`Loading voice… ${Math.round(state.modelProgress * 100)}%`, true);
    } else if (state.busy) {
      this.setToast(`Buffering…${eng}`, true);
    } else if (state.hint) {
      this.setToast(state.hint, false);
    } else {
      this.toast.hidden = true;
      this.toast.replaceChildren();
    }
  }

  private setToast(text: string, spinner: boolean, isError = false): void {
    this.toast.className = isError ? 'toast err' : 'toast';
    const kids: Node[] = [];
    if (spinner) kids.push(el(this.doc, 'span', { class: 'spinner' }));
    kids.push(this.doc.createTextNode(text));
    this.toast.replaceChildren(...kids);
    this.toast.hidden = false;
  }

  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    this.speedEl.value = String(speed);
  }

  focus(): void {
    try {
      this.bar.focus({ preventScroll: true });
    } catch {
      /* noop */
    }
  }

  dispose(): void {
    this.host.remove();
  }
}
