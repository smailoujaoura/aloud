/**
 * Per-tab reader session: the content-script orchestrator.
 *
 * Its job is wiring, not policy. Extraction, planning, geometry, click-to-jump, audio scheduling
 * and synthesis each live in their own module; this class owns the *lifecycle* that connects
 * them and the single piece of mutable state they all read — where we are in the playlist.
 *
 *   extract/     → what text is on this page, and where it lives in the DOM
 *   playlist     → the ordered list of things to say, with a Range each
 *   engine/      → the synthesis worker pool, behind WorkerClient
 *   audio/       → the gapless scheduler that turns PCM into sound
 *   highlight/   → what the reader sees while it plays
 *   ui/          → the control bar
 *
 * Lifecycle: created on activation, torn down on stop / navigation / being superseded by another
 * tab. Exactly one instance per tab (guarded in entrypoints/reader-inject.ts).
 */
import { browser } from 'wxt/browser';

import { extractArticle } from '@/extract/readability';
import { resolveLiveRoot } from '@/extract/live-container';
import { buildTextIndex, type TextIndex } from '@/extract/text-index';
import { normalizeForSpeech } from '@/segment/normalize';
import { GaplessScheduler } from '@/audio/scheduler';
import { Highlighter } from '@/highlight/highlighter';
import { ControlBar } from '@/ui/control-bar';
import { WorkerClient } from '@/engine/worker-client';
import type { EngineConfig } from '@/engine/protocol';
import type { ModelManifest } from '@/engine/engines/types';
import { getSettings, setSettings, activeVoice, voiceKeyFor, type Settings } from '@/shared/settings';
import { listVoices } from '@/shared/voice-catalog';
import { PORT_NAME, type ActivateMode, type SessionState } from '@/shared/messages';
import { log } from '@/shared/log';

import { tuningFor } from './engine-tuning';
import {
  buildArticlePlaylist,
  buildSelectionPlaylist,
  leadSilenceSec,
  type PlaylistItem,
} from './playlist';
import { firstSentenceInViewport, indexAtPoint, indexNearElement } from './playlist-navigation';
import { TapToSeek } from './tap-to-seek';

interface BeginOptions {
  /** For "Read from here": the element that was right-clicked, when the browser can tell us. */
  targetElement?: Element | null;
}

/** A selection snapshot, taken before any async work can disturb it. */
interface SelectionSnapshot {
  text: string;
  range: Range | null;
}

/** Below this many characters a selection isn't worth reading — fall back to the whole article. */
const MIN_SELECTION_CHARS = 15;

export class ReaderSession {
  // ---- subsystems (built in begin()) --------------------------------------
  private settings!: Settings;
  private scheduler!: GaplessScheduler;
  private worker!: WorkerClient;
  private highlighter: Highlighter | null = null;
  private bar: ControlBar | null = null;
  private tapToSeek: TapToSeek | null = null;
  private port: ReturnType<typeof browser.runtime.connect> | null = null;
  private manifest: ModelManifest | null = null;

  // ---- what we are reading -------------------------------------------------
  private textIndex: TextIndex | null = null;
  private playlist: PlaylistItem[] = [];
  private mode: ActivateMode = 'article';
  private startTarget: Element | null = null;
  private selection: SelectionSnapshot = { text: '', range: null };

  // ---- where we are --------------------------------------------------------
  private currentPlayId = 0;
  /** Sentences already handed to the worker, so we never request one twice. */
  private readonly requested = new Set<number>();
  /** Last highlight range actually shown — reused when a sentence has no range of its own. */
  private lastShownRange: Range | null = null;

  private engineReady = false;
  private wantsPlayback = false;
  private disposed = false;
  /** Sample rate the active engine produces. Used to build the silence that replaces a
   *  sentence which failed to synthesise. */
  private sampleRate = 22050;

  private state: SessionState = {
    status: 'idle',
    currentIndex: 0,
    totalChunks: 0,
    title: '',
    modelProgress: 0,
  };

  // ---- tuning --------------------------------------------------------------

  private get tuning() {
    return tuningFor(this.settings.engine);
  }

  // ---- startup -------------------------------------------------------------

  async begin(mode: ActivateMode = 'article', opts: BeginOptions = {}): Promise<void> {
    this.mode = mode;
    this.startTarget = opts.targetElement ?? null;
    // Snapshot the page selection *now*, before any await or DOM work can disturb it.
    if (mode === 'selection') this.selection = snapshotSelection();
    // "Read selection" / "Read from here" are explicit "start reading now" actions.
    this.wantsPlayback = mode === 'selection' || mode === 'from-cursor';

    this.settings = await getSettings();
    this.manifest = await this.loadManifest();
    this.connectPort();
    this.buildSubsystems();

    this.setStatus('extracting');
    try {
      this.extractAndPlan();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.playlist.length === 0) {
      this.fail("Couldn't find any readable text on this page.");
      return;
    }

    this.tapToSeek?.setEnabled(this.settings.tapToSeek);
    await this.loadEngine();
  }

  private buildSubsystems(): void {
    this.scheduler = this.createScheduler();

    this.worker = new WorkerClient({
      onReady: ({ sampleRate, executionProvider }) => this.onEngineReady(executionProvider, sampleRate),
      onProgress: ({ progress }) => {
        this.state.modelProgress = progress;
        if (this.state.status === 'loading-model') this.pushState();
      },
      onAudio: (playId, pcm, sr) =>
        this.scheduler.provide(playId, pcm, sr, leadSilenceSec(this.playlist[playId], this.settings)),
      onError: ({ message, fatal, stack, playId }) => {
        log.error('worker error:', message, stack ? `\n${stack}` : '');
        if (fatal) this.fail(message);
        else if (playId != null) this.skipSentence(playId);
      },
    });

    this.bar = new ControlBar(document, this.controlCallbacks(), this.settings.speed, this.settings.tapToSeek);
    this.refreshBarVoices();

    this.highlighter = new Highlighter(document, {
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
    });

    this.tapToSeek = new TapToSeek(document, {
      hitTest: (x, y) => indexAtPoint(this.playlist, x, y),
      canSeek: () =>
        this.playlist.length > 0 && this.state.status !== 'error' && this.state.status !== 'extracting',
      onSeek: (playId) => {
        const wasPlaying = this.scheduler.isPlaying();
        this.seekTo(playId);
        // The click is a real user gesture, so it is safe to start audio from here.
        if (!wasPlaying) void this.play();
      },
    });
  }

  /**
   * The scheduler is rebuilt from scratch on an engine change (a new engine means a new sample
   * rate and a dead queue), so its wiring lives in one place rather than being repeated.
   */
  private createScheduler(): GaplessScheduler {
    return new GaplessScheduler({
      onChunkStart: (id) => this.onChunkStart(id),
      onChunkEnd: (id) => this.onChunkEnd(id),
      onNeedMore: (id) => this.ensureSynth(id),
      onUnderrun: (id) => this.onUnderrun(id),
      onFinished: () => this.onFinished(),
    });
  }

  private onEngineReady(executionProvider: string, sampleRate: number): void {
    this.engineReady = true;
    this.sampleRate = sampleRate;
    this.state.engineInfo = executionProvider;
    log.info('engine ready', executionProvider, `${sampleRate}Hz`);
    this.setStatus(this.wantsPlayback ? 'playing' : 'paused');
    // Pre-synthesise around wherever the user is now — they may have jumped to a section while
    // the model was still loading.
    if (this.currentPlayId > 0) this.scheduler.seek(this.currentPlayId);
    if (this.wantsPlayback) void this.startPlayback();
    else this.ensureSynth(this.currentPlayId);
  }

  private async loadEngine(): Promise<void> {
    this.setStatus('loading-model');
    try {
      await this.worker.init(this.engineConfig());
    } catch (err) {
      this.fail(`Failed to load the voice model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- extraction & planning ----------------------------------------------

  private normalize = (text: string): string =>
    normalizeForSpeech(text, {
      urlReplacement: this.settings.skipUrls ? 'link' : text,
      expandAbbreviations: this.settings.expandAbbreviations,
    });

  private extractAndPlan(): void {
    const article = extractArticle(document);
    this.state.title = article.title || document.title;

    const useSelection = this.mode === 'selection' && this.selection.text.length > MIN_SELECTION_CHARS;
    if (useSelection) {
      this.state.title = 'Selection';
      this.textIndex = buildTextIndex(selectionRoot(this.selection));
      this.playlist = buildSelectionPlaylist({
        index: this.textIndex,
        lang: article.lang,
        maxChars: this.tuning.maxChars,
        normalize: this.normalize,
        sourceText: this.selection.text,
      });
    } else {
      if (this.mode === 'selection') log.warn('no usable selection — reading the whole article instead');
      if (!article.text || article.text.length < 40) {
        throw new Error("This page doesn't look like an article.");
      }
      this.textIndex = buildTextIndex(resolveLiveRoot(article, document));
      this.playlist = buildArticlePlaylist({
        index: this.textIndex,
        lang: article.lang,
        maxChars: this.tuning.maxChars,
        normalize: this.normalize,
        referenceText: article.text,
        title: this.state.title,
      });
    }

    this.state.totalChunks = this.playlist.length;
    if (this.mode === 'from-cursor') this.startFromCursor();
    this.logPlan();
  }

  /** "Read from here": start at the clicked element, or at the first sentence on screen. */
  private startFromCursor(): void {
    const startAt = this.startTarget
      ? indexNearElement(this.playlist, this.startTarget)
      : firstSentenceInViewport(this.playlist);
    if (startAt <= 0) return;
    this.currentPlayId = startAt;
    this.state.currentIndex = startAt;
    this.highlighter?.show(this.playlist[startAt]?.range ?? null);
  }

  private logPlan(): void {
    const located = this.playlist.filter((p) => p.range).length;
    const missing = this.playlist.length - located;
    log.info(
      `planned ${this.playlist.length} sentences; ${located} located in DOM` +
        (missing > 0 ? ` (${missing} not located)` : '') +
        (this.currentPlayId ? `; starting at ${this.currentPlayId}` : ''),
    );
  }

  // ---- playback control ----------------------------------------------------

  private controlCallbacks() {
    return {
      onPlay: () => void this.play(),
      onPause: () => void this.pause(),
      onPrev: () => this.seekBy(-1),
      onNext: () => this.seekBy(1),
      onSeekFraction: (f: number) => this.seekTo(Math.floor(f * this.playlist.length)),
      onSpeed: (s: number) => void this.setSpeed(s),
      onVoice: (v: string) => void this.changeVoice(v),
      onToggleTapToSeek: (on: boolean) => void this.setTapToSeek(on),
      onOpenSettings: () => this.port?.postMessage({ type: 'open-options' }),
      onClose: () => this.stop('user'),
    };
  }

  async play(): Promise<void> {
    this.wantsPlayback = true;
    this.state.hint = undefined;
    // Reflect the intent immediately — the button shouldn't wait for the AudioContext.
    if (this.engineReady) this.state.status = 'playing';
    this.pushState();

    // Create/resume the AudioContext now, inside this real user gesture.
    if (!this.scheduler.audioContext) {
      await this.scheduler
        .start(this.playlist.length, this.currentPlayId, this.tuning.primeSeconds)
        .catch(() => undefined);
      // If the engine isn't up yet nothing was scheduled; onEngineReady will start playback.
      if (!this.engineReady) return;
    }
    if (this.scheduler.isPlaying()) {
      this.setStatus('playing');
      return;
    }
    await this.startPlayback();
  }

  private async startPlayback(): Promise<void> {
    const ctx = this.scheduler.audioContext;
    if (!ctx) {
      await this.scheduler
        .start(this.playlist.length, this.currentPlayId, this.tuning.primeSeconds)
        .catch(() => undefined);
    } else if (ctx.state === 'suspended') {
      await this.scheduler.unpause();
    }
    this.setStatus('playing');
    this.ensureSynth(this.currentPlayId);

    // Autoplay (from "Read selection" / "Read from here") can be blocked — the browser wants a
    // real click first. If we wanted to play but aren't, say so and draw the eye to the button.
    // `onChunkStart` clears this the moment audio actually starts.
    if (this.wantsPlayback && !this.scheduler.isPlaying()) {
      this.state.status = 'paused';
      this.state.hint = 'Press ▶ to start';
      this.pushState();
    }
  }

  async pause(): Promise<void> {
    this.wantsPlayback = false;
    this.state.busy = false;
    this.state.hint = undefined;
    await this.scheduler.pause();
    this.setStatus('paused');
  }

  /** Toolbar / shortcut activation on an already-running session. */
  async externalToggle(): Promise<void> {
    if (this.state.status === 'error' || this.state.status === 'extracting') return;
    if (this.scheduler?.isPlaying()) await this.pause();
    else await this.play();
  }

  seekBy(delta: number): void {
    this.seekTo(this.currentPlayId + delta);
  }

  seekTo(playId: number): void {
    const target = Math.max(0, Math.min(playId, this.playlist.length - 1));
    this.currentPlayId = target;
    this.state.currentIndex = target;
    this.highlighter?.show(this.playlist[target]?.range ?? null);

    // The worker drops its whole queue on cancel; clear our matching bookkeeping so ensureSynth
    // actually re-requests the sentences around the new position (even if we've been here before).
    this.requested.clear();
    this.worker.cancelFrom(target);
    this.scheduler.seek(target);
    if (this.engineReady) this.ensureSynth(target);
    // Playback has to wait for the new sentence to synthesise; show that.
    this.state.busy = this.engineReady && this.scheduler.isPlaying();
    this.pushState();
  }

  async setSpeed(speed: number): Promise<void> {
    this.settings = await setSettings({ speed });
    this.bar?.setSpeed(speed);
    if (!this.engineReady) return;
    // The sentence already playing keeps its old rate; everything after it is re-synthesised.
    const keepFrom = this.currentPlayId + 1;
    this.requested.clear();
    this.worker.cancelFrom(keepFrom);
    this.scheduler.reprimeForSpeed();
    this.ensureSynth(keepFrom);
    this.state.busy = this.scheduler.isPlaying();
    this.pushState();
  }

  // ---- engine & voice ------------------------------------------------------

  private engineConfig(): EngineConfig {
    return {
      engine: this.settings.engine,
      voice: activeVoice(this.settings),
      dtype: this.settings.kokoroDtype,
      steps: this.settings.supertonicSteps,
      preferWebGPU: this.settings.preferWebGPU,
      speed: this.settings.speed,
      workers: this.settings.synthWorkers,
    };
  }

  private async loadManifest(): Promise<ModelManifest | null> {
    try {
      const res = await fetch(browser.runtime.getURL('/models.json'));
      return (await res.json()) as ModelManifest;
    } catch (err) {
      log.warn('could not load models.json:', err);
      return null;
    }
  }

  /** Fill the control bar's voice picker for the active engine. */
  private refreshBarVoices(): void {
    if (!this.bar || !this.manifest) return;
    this.bar.setVoices(listVoices(this.settings.engine, this.manifest), activeVoice(this.settings));
  }

  /** Switch voice from the in-page bar, keeping the plan and position. */
  private async changeVoice(voice: string): Promise<void> {
    if (activeVoice(this.settings) === voice) return;
    this.settings = await setSettings({ [voiceKeyFor(this.settings.engine)]: voice });
    await this.reloadEngine();
  }

  /** Re-initialise the worker for a new engine/voice, keeping the plan and position. */
  async reloadEngine(): Promise<void> {
    this.settings = await getSettings();
    this.refreshBarVoices();
    this.engineReady = false;
    this.requested.clear();
    this.state.modelProgress = 0;
    await this.scheduler.dispose();
    this.scheduler = this.createScheduler();
    await this.loadEngine();
  }

  // ---- pipeline glue -------------------------------------------------------

  /** Keep the worker queue topped up from `fromPlayId` for the current engine's lookahead. */
  private ensureSynth(fromPlayId: number): void {
    if (!this.engineReady) return;
    const end = Math.min(fromPlayId + this.tuning.lookahead + 1, this.playlist.length);
    for (let i = fromPlayId; i < end; i++) {
      if (this.requested.has(i)) continue;
      const item = this.playlist[i];
      if (!item) continue;
      this.requested.add(i);
      this.worker.request(i, item.spokenText, this.settings.speed);
    }
  }

  private onChunkStart(playId: number): void {
    this.currentPlayId = playId;
    this.state.currentIndex = playId;
    // Audio is actually flowing — reconcile the UI with reality.
    this.state.busy = false;
    this.state.hint = undefined;
    if (this.wantsPlayback && this.state.status !== 'playing') this.state.status = 'playing';

    if (this.settings.highlight) {
      // Never blank the highlight while audio is playing: fall back to the enclosing block, then
      // to whatever was last shown, so the reader's eye is never left stranded.
      const item = this.playlist[playId];
      const range = item?.range ?? item?.blockRange ?? this.lastShownRange;
      if (range) this.lastShownRange = range;
      this.highlighter?.show(range);
    }

    this.ensureSynth(playId + 1);
    this.pushState();
  }

  /**
   * Replace a sentence that could not be synthesised with a moment of silence.
   *
   * Without this the scheduler waits on that slot forever — it plays strictly in order — so one
   * failed sentence stalls the rest of the article behind a permanent "Buffering…", with no way
   * out but a manual seek past it.
   */
  private skipSentence(playId: number): void {
    log.warn(`sentence ${playId} could not be synthesised — skipping it`);
    this.requested.delete(playId);
    this.scheduler.provide(playId, new Float32Array(0), this.sampleRate, 0);
  }

  private onChunkEnd(playId: number): void {
    if (playId >= this.playlist.length - 1) return;
    this.ensureSynth(playId + 1);
  }

  private onUnderrun(playId: number): void {
    // Ran out of ready audio mid-playback (common with the slower neural engines). Say so.
    if (this.state.status === 'playing') {
      this.state.busy = true;
      this.pushState();
    }
    this.ensureSynth(playId);
  }

  private onFinished(): void {
    this.wantsPlayback = false;
    this.state.busy = false;
    this.highlighter?.clear();
    this.currentPlayId = 0;
    this.state.currentIndex = this.playlist.length;
    this.setStatus('paused');
  }

  // ---- settings ------------------------------------------------------------

  /** Persist the click-to-jump toggle (flipped from the in-page bar) and apply it live. */
  private async setTapToSeek(on: boolean): Promise<void> {
    this.settings = await setSettings({ tapToSeek: on });
    this.tapToSeek?.setEnabled(on);
    this.bar?.setTapToSeek(on);
  }

  private async onSettingsChanged(): Promise<void> {
    const prev = this.settings;
    this.settings = await getSettings();

    this.highlighter?.setOptions({
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
    });
    if (prev.tapToSeek !== this.settings.tapToSeek) {
      this.tapToSeek?.setEnabled(this.settings.tapToSeek);
      this.bar?.setTapToSeek(this.settings.tapToSeek);
    }
    if (prev.speed !== this.settings.speed) this.bar?.setSpeed(this.settings.speed);

    if (needsEngineReload(prev, this.settings)) await this.reloadEngine();
  }

  // ---- state / messaging ---------------------------------------------------

  private connectPort(): void {
    try {
      this.port = browser.runtime.connect({ name: PORT_NAME });
      this.port.onMessage.addListener((msg: unknown) => {
        const m = msg as { type?: string };
        if (m.type === 'stop') this.stop('superseded');
        else if (m.type === 'toggle') void this.externalToggle();
        else if (m.type === 'settings-changed') void this.onSettingsChanged();
        else if (m.type === 'query-state') this.pushState();
      });
      this.port.onDisconnect.addListener(() => (this.port = null));
    } catch (err) {
      log.warn('could not connect to background:', err);
    }
  }

  private setStatus(status: SessionState['status']): void {
    this.state.status = status;
    this.pushState();
  }

  private pushState(): void {
    if (this.disposed) return;
    this.bar?.update(this.state);
    try {
      this.port?.postMessage({ type: 'state', state: this.state });
    } catch {
      /* port gone */
    }
  }

  private fail(message: string): void {
    this.state.error = message;
    this.setStatus('error');
    log.error(message);
  }

  // ---- teardown ------------------------------------------------------------

  stop(reason: 'user' | 'superseded' | 'navigation'): void {
    log.info('session stop:', reason);
    void this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.tapToSeek?.dispose();
    try {
      this.port?.postMessage({ type: 'session-ended' });
      this.port?.disconnect();
    } catch {
      /* noop */
    }
    await this.scheduler?.dispose();
    this.worker?.dispose();
    this.highlighter?.dispose();
    this.bar?.dispose();

    // Only clear the global if it still points at us — a replacement session ("Read from here" /
    // "Read selection" on a running reader) may already have taken the slot.
    const w = window as unknown as { __aloudSession?: unknown };
    if (w.__aloudSession === this) w.__aloudSession = undefined;
  }
}

// ---- helpers ---------------------------------------------------------------

function snapshotSelection(): SelectionSnapshot {
  const sel = window.getSelection();
  return {
    text: sel?.toString().replace(/\s+/g, ' ').trim() ?? '',
    range: sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null,
  };
}

/**
 * The smallest element that contains the whole selection — the root to index for highlighting.
 * `commonAncestorContainer` can be a text node, or an element that holds only part of the text
 * when the selection crosses nodes, so climb until it plausibly covers the selected text.
 */
function selectionRoot(selection: SelectionSnapshot): Element {
  const container = selection.range?.commonAncestorContainer ?? null;
  let root: Element =
    (container?.nodeType === Node.ELEMENT_NODE ? (container as Element) : container?.parentElement) ??
    document.body;
  while (root !== document.body && (root.textContent ?? '').length < selection.text.length) {
    root = root.parentElement ?? document.body;
  }
  return root;
}

/** Settings that require tearing the engine down and loading a different model. */
function needsEngineReload(prev: Settings, next: Settings): boolean {
  return (
    prev.engine !== next.engine ||
    prev.piperVoice !== next.piperVoice ||
    prev.kokoroVoice !== next.kokoroVoice ||
    prev.supertonicVoice !== next.supertonicVoice ||
    prev.kokoroDtype !== next.kokoroDtype ||
    prev.supertonicSteps !== next.supertonicSteps ||
    prev.preferWebGPU !== next.preferWebGPU ||
    prev.synthWorkers !== next.synthWorkers
  );
}
