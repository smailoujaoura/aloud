import { browser } from 'wxt/browser';
/**
 * Per-tab reader session: the content-script orchestrator that wires extraction, segmentation,
 * DOM highlighting, the synthesis Worker and the gapless audio scheduler together.
 *
 * Lifecycle: created on activation, torn down on stop / navigation / being superseded by another
 * tab. Exactly one instance per tab (guarded in entrypoints/content.ts).
 */
import { extractArticle } from '@/extract/readability';
import { resolveLiveRoot } from '@/extract/live-container';
import { buildTextIndex, rangeForSpan, type TextIndex } from '@/extract/text-index';
import { buildBlockModel, type BlockRole } from '@/extract/block-model';
import { segmentSentences } from '@/segment/sentences';
import { normalizeForSpeech, isSpeakable } from '@/segment/normalize';
import { Aligner } from '@/align/fuzzy-align';
import { GaplessScheduler } from '@/audio/scheduler';
import { Highlighter } from '@/highlight/highlighter';
import { ControlBar } from '@/ui/control-bar';
import { WorkerClient } from '@/engine/worker-client';
import type { EngineConfig } from '@/engine/protocol';
import type { ModelManifest } from '@/engine/engines/types';
import { getSettings, setSettings, activeVoice, voiceKeyFor, type Settings } from '@/shared/settings';
import { PORT_NAME, type ActivateMode, type SessionState } from '@/shared/messages';
import { log } from '@/shared/log';

interface PlaylistItem {
  playId: number;
  chunkIndex: number;
  spokenText: string;
  /** Highlight range for this exact sentence, or null if it could not be located. */
  range: Range | null;
  /** Highlight range for the whole enclosing block — the fallback when `range` is null. */
  blockRange: Range | null;
  /** Structural role of the block this sentence belongs to. */
  role: BlockRole;
  /** True when this sentence is the first of a new block (paragraph / list item / heading). */
  startsBlock: boolean;
  /** True when the enclosing block is a heading. */
  isHeading: boolean;
}

interface BeginOptions {
  /** For "Read from here": the element that was right-clicked. */
  targetElement?: Element | null;
}

/** How many sentences to keep synthesised ahead of playback. The neural engines are slow on
 *  the single-threaded WASM path and are synthesised by a *pool* of workers (see synth-host),
 *  so the queue must be deep enough to keep every worker busy — a few jobs each. */
const LOOKAHEAD_BY_ENGINE: Record<string, number> = { piper: 4, kokoro: 24, supertonic: 20 };

/** Seconds of audio to buffer before the first note. Kept modest so "press play" isn't a long
 *  silent wait — the deep lookahead above is what prevents mid-article underruns. */
const PRIME_SECONDS_BY_ENGINE: Record<string, number> = { piper: 1.5, kokoro: 3.5, supertonic: 3.5 };

/** Upper bound on chunk length (chars) before clause-splitting. Smaller = shorter underruns. */
const MAX_CHARS_BY_ENGINE: Record<string, number> = { piper: 240, kokoro: 160, supertonic: 160 };

export class ReaderSession {
  private settings!: Settings;
  private scheduler!: GaplessScheduler;
  private worker!: WorkerClient;
  private highlighter: Highlighter | null = null;
  private bar: ControlBar | null = null;
  private port: ReturnType<typeof browser.runtime.connect> | null = null;

  private textIndex: TextIndex | null = null;
  private playlist: PlaylistItem[] = [];
  /** Last highlight range actually shown — reused when a sentence has no range of its own. */
  private lastShownRange: Range | null = null;
  private readonly requested = new Set<number>();
  private sampleRate = 22050;

  private engineReady = false;
  private wantsPlayback = false;
  private currentPlayId = 0;
  private disposed = false;

  private state: SessionState = {
    status: 'idle',
    currentIndex: 0,
    totalChunks: 0,
    title: '',
    modelProgress: 0,
  };

  private mode: ActivateMode = 'article';
  private startTarget: Element | null = null;
  private selectionText = '';
  private selectionRange: Range | null = null;
  private tapToSeekHandler: ((e: MouseEvent) => void) | null = null;
  private manifest: ModelManifest | null = null;

  private get lookahead(): number {
    return LOOKAHEAD_BY_ENGINE[this.settings.engine] ?? 4;
  }

  /** Seconds of audio to buffer before the first note. */
  private get primeSeconds(): number {
    return PRIME_SECONDS_BY_ENGINE[this.settings.engine] ?? 1.5;
  }

  async begin(mode: ActivateMode = 'article', opts: BeginOptions = {}): Promise<void> {
    this.mode = mode;
    this.startTarget = opts.targetElement ?? null;

    // Snapshot the page selection *now*, before any await or DOM work can disturb it.
    if (mode === 'selection') {
      const sel = window.getSelection();
      this.selectionText = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
      this.selectionRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    }
    // "Read selection" / "Read from here" are explicit "start reading now" actions.
    this.wantsPlayback = mode === 'selection' || mode === 'from-cursor';

    this.settings = await getSettings();
    this.manifest = await this.loadManifest();
    this.connectPort();

    this.scheduler = new GaplessScheduler({
      onChunkStart: (id) => this.onChunkStart(id),
      onChunkEnd: (id) => this.onChunkEnd(id),
      onNeedMore: (id) => this.ensureSynth(id),
      onUnderrun: (id) => this.onUnderrun(id),
      onFinished: () => this.onFinished(),
    });

    this.worker = new WorkerClient({
      onReady: ({ sampleRate, executionProvider }) => {
        this.sampleRate = sampleRate;
        this.engineReady = true;
        this.state.engineInfo = executionProvider;
        log.info('engine ready', executionProvider, sampleRate + 'Hz');
        this.setStatus(this.wantsPlayback ? 'playing' : 'paused');
        // Pre-synthesise around wherever the user is now — they may have jumped to a section
        // while the model was still loading.
        if (this.currentPlayId > 0) this.scheduler.seek(this.currentPlayId);
        if (this.wantsPlayback) void this.startPlayback();
        else this.ensureSynth(this.currentPlayId);
      },
      onProgress: ({ progress }) => {
        this.state.modelProgress = progress;
        if (this.state.status === 'loading-model') this.pushState();
      },
      onAudio: (playId, pcm, sr) =>
        this.scheduler.provide(playId, pcm, sr, this.leadSilenceSec(this.playlist[playId])),
      onError: ({ message, fatal, stack }) => {
        log.error('worker error:', message, stack ? `\n${stack}` : '');
        if (fatal) this.fail(message);
      },
    });

    this.bar = new ControlBar(
      document,
      this.controlCallbacks(),
      this.settings.speed,
      this.settings.tapToSeek,
    );
    this.refreshBarVoices();
    this.highlighter = new Highlighter(document, {
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
    });

    this.setStatus('extracting');

    try {
      await this.extractAndPlan();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }

    if (this.playlist.length === 0) {
      this.fail("Couldn't find any readable text on this page.");
      return;
    }

    this.applyTapToSeek();
    this.setStatus('loading-model');
    try {
      await this.worker.init(this.engineConfig());
    } catch (err) {
      this.fail(`Failed to load the voice model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private get maxChars(): number {
    return MAX_CHARS_BY_ENGINE[this.settings.engine] ?? 240;
  }

  private normalize(text: string): string {
    return normalizeForSpeech(text, {
      urlReplacement: this.settings.skipUrls ? 'link' : text,
      expandAbbreviations: this.settings.expandAbbreviations,
    });
  }

  private async extractAndPlan(): Promise<void> {
    const article = extractArticle(document);
    this.state.title = article.title || document.title;

    const useSelection = this.mode === 'selection' && this.selectionText.length > 15;

    if (useSelection) {
      const container = this.selectionRange?.commonAncestorContainer ?? null;
      let root: Element =
        (container?.nodeType === Node.ELEMENT_NODE
          ? (container as Element)
          : container?.parentElement) ?? document.body;
      while (root !== document.body && (root.textContent ?? '').length < this.selectionText.length) {
        root = root.parentElement ?? document.body;
      }
      this.state.title = 'Selection';
      this.textIndex = buildTextIndex(root);
      this.planFromText(this.selectionText, article.lang);
    } else {
      if (this.mode === 'selection') {
        log.warn('no usable selection — reading the whole article instead');
      }
      if (!article.text || article.text.length < 40) {
        throw new Error("This page doesn't look like an article.");
      }
      const root = resolveLiveRoot(article, document);
      this.textIndex = buildTextIndex(root);
      this.planFromBlocks(article.lang, article.text, this.state.title);
    }

    const playlist = this.playlist;
    this.state.totalChunks = playlist.length;

    // "Read from here": start at the clicked element, or — if the browser gave us no element —
    // at the first sentence currently visible in the viewport (that's what "here" means).
    if (this.mode === 'from-cursor') {
      const startAt = this.startTarget
        ? this.playlistIndexNear(this.startTarget)
        : this.firstSentenceInViewport();
      if (startAt > 0) {
        this.currentPlayId = startAt;
        this.state.currentIndex = startAt;
        this.highlighter?.show(playlist[startAt]?.range ?? null);
      }
    }

    const located = playlist.filter((p) => p.range).length;
    log.info(
      `planned ${playlist.length} sentences; ${located} located in DOM` +
        (located < playlist.length ? ` (${playlist.length - located} not located)` : '') +
        (this.currentPlayId ? `; starting at ${this.currentPlayId}` : ''),
    );
  }

  /**
   * Article / "read from here": build the playlist by walking the live DOM's block structure
   * in document order. Each sentence maps to an exact slice of the text index, so what is
   * spoken is what is highlighted, in order — no cross-document fuzzy alignment.
   */
  private planFromBlocks(lang: string, referenceText: string, title: string): void {
    const index = this.textIndex!;
    const blocks = buildBlockModel(index, { referenceText, title });
    const playlist: PlaylistItem[] = [];

    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]!;
      const blockRange =
        block.end > block.start ? rangeForSpan(index, block.start, block.end) : null;

      // Synthetic spoken-only title block (couldn't be located in the DOM).
      if (block.end <= block.start) {
        const spoken = this.normalize(title);
        if (isSpeakable(spoken)) {
          playlist.push({
            playId: playlist.length,
            chunkIndex: playlist.length,
            spokenText: spoken,
            range: null,
            blockRange: null,
            role: block.role,
            startsBlock: true,
            isHeading: true,
          });
        }
        continue;
      }

      const blockText = index.fullText.slice(block.start, block.end);
      const chunks = segmentSentences(blockText, { locale: lang, maxChars: this.maxChars });
      let first = true;
      for (const chunk of chunks) {
        const spoken = this.normalize(chunk.text);
        if (!isSpeakable(spoken)) continue;
        const range = rangeForSpan(index, block.start + chunk.start, block.start + chunk.end);
        playlist.push({
          playId: playlist.length,
          chunkIndex: playlist.length,
          spokenText: spoken,
          range: range ?? blockRange,
          blockRange,
          role: block.role,
          startsBlock: first,
          isHeading: block.role === 'heading' || block.role === 'title',
        });
        first = false;
      }
    }

    this.playlist = playlist;
  }

  /** Selection mode: no reliable block structure, so segment the selected text and fuzzy-locate. */
  private planFromText(sourceText: string, lang: string): void {
    const index = this.textIndex!;
    const chunks = segmentSentences(sourceText, { locale: lang, maxChars: this.maxChars });
    const aligner = new Aligner(index.fullText);
    const playlist: PlaylistItem[] = [];
    for (const chunk of chunks) {
      const spoken = this.normalize(chunk.text);
      if (!isSpeakable(spoken)) continue;
      const found = aligner.locate(chunk.text, chunk.index);
      const range = found ? rangeForSpan(index, found.start, found.end) : null;
      playlist.push({
        playId: playlist.length,
        chunkIndex: playlist.length,
        spokenText: spoken,
        range,
        blockRange: null,
        role: 'paragraph',
        startsBlock: false,
        isHeading: false,
      });
    }
    this.playlist = playlist;
  }

  /** Leading silence (seconds) to prepend to a chunk, from the pause settings. */
  private leadSilenceSec(item: PlaylistItem | undefined): number {
    if (!item) return 0;
    let ms = this.settings.sentencePauseMs;
    if (item.startsBlock) ms = Math.max(ms, this.settings.sectionPauseMs);
    if (item.isHeading && item.playId > 0) ms = Math.max(ms, this.settings.sectionPauseMs, 250);
    return ms / 1000;
  }

  /** First sentence that is currently on screen (used by "Read from here" with no click target). */
  private firstSentenceInViewport(): number {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let above = 0;
    for (const item of this.playlist) {
      const rect = item.range?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) continue;
      if (rect.bottom > 8 && rect.top < vh) return item.playId; // visible
      if (rect.bottom <= 8) above = item.playId; // scrolled past — remember as a floor
    }
    return above;
  }

  /** The playlist index of the first sentence whose text is at or inside `el` (document order). */
  private playlistIndexNear(el: Element): number {
    let fallback = 0;
    for (const item of this.playlist) {
      const node = item.range?.startContainer;
      if (!node) continue;
      const rel = el.compareDocumentPosition(node);
      // node follows `el`, or is contained by it, or is `el` itself → this is where to start.
      if (rel === 0 || rel & Node.DOCUMENT_POSITION_FOLLOWING || rel & Node.DOCUMENT_POSITION_CONTAINED_BY) {
        return item.playId;
      }
      fallback = item.playId; // this sentence is before the click; remember it as a floor
    }
    return fallback;
  }

  // ---- tap-to-seek --------------------------------------------------------

  /** Persist the click-to-jump toggle (flipped from the in-page bar) and apply it live. */
  private async setTapToSeek(on: boolean): Promise<void> {
    this.settings = await setSettings({ tapToSeek: on });
    this.applyTapToSeek();
  }

  /** Add or remove the page click listener to match `settings.tapToSeek`. Idempotent. */
  private applyTapToSeek(): void {
    if (this.settings.tapToSeek) {
      this.installTapToSeek();
    } else if (this.tapToSeekHandler) {
      document.removeEventListener('click', this.tapToSeekHandler, true);
      this.tapToSeekHandler = null;
    }
    this.bar?.setTapToSeek(this.settings.tapToSeek);
  }

  /** Let the reader jump when the user clicks a sentence in the page. Non-invasive: capture-phase,
   *  never preventDefault, ignores clicks on links / form controls / our own UI. */
  private installTapToSeek(): void {
    if (!this.settings.tapToSeek || this.tapToSeekHandler) return;
    const onClick = (e: MouseEvent): void => {
      if (e.button !== 0 || e.detail > 1 || e.defaultPrevented) return;
      if (!this.playlist.length || this.state.status === 'error' || this.state.status === 'extracting') return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          'a, button, input, select, textarea, label, summary, audio, video, [role="button"], [role="link"], [contenteditable=""], [contenteditable="true"]',
        )
      ) {
        return;
      }
      if (e.composedPath().some((n) => n instanceof HTMLElement && n.id === 'aloud-control-host')) return;
      if (window.getSelection && !window.getSelection()?.isCollapsed) return; // user is selecting text

      const id = this.playlistIndexAtPoint(e.clientX, e.clientY);
      if (id == null) return;
      const wasPlaying = this.scheduler.isPlaying();
      this.seekTo(id);
      if (!wasPlaying) void this.play(); // the click is a real gesture — safe to start audio
    };
    this.tapToSeekHandler = onClick;
    document.addEventListener('click', onClick, true);
  }

  private playlistIndexAtPoint(x: number, y: number): number | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    const cp = doc.caretPositionFromPoint?.(x, y);
    if (cp) {
      node = cp.offsetNode;
      offset = cp.offset;
    } else {
      const cr = doc.caretRangeFromPoint?.(x, y);
      if (cr) {
        node = cr.startContainer;
        offset = cr.startOffset;
      }
    }
    if (!node) return null;

    for (const item of this.playlist) {
      try {
        if (item.range?.isPointInRange(node, offset)) return item.playId;
      } catch {
        /* node not comparable with this range */
      }
    }
    // Clicked in a gap between sentences — snap to the nearest one by document order.
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return el ? this.playlistIndexNear(el) : null;
  }

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
    let voices: Array<{ id: string; label: string; group?: string }> = [];
    if (this.settings.engine === 'kokoro') {
      voices = Object.entries(this.manifest.kokoro.voices).map(([id, v]) => ({
        id,
        label: v.label,
        group: v.language,
      }));
    } else if (this.settings.engine === 'supertonic' && this.manifest.supertonic) {
      voices = Object.entries(this.manifest.supertonic.voices).map(([id, v]) => ({
        id,
        label: v.label,
      }));
    } else {
      voices = Object.entries(this.manifest.piper).map(([id, v]) => ({
        id,
        label: `${v.label} · ${v.quality}`,
        group: v.language,
      }));
    }
    this.bar.setVoices(voices, activeVoice(this.settings));
  }

  /** Switch voice from the in-page bar, keeping the plan and position. */
  private async changeVoice(voice: string): Promise<void> {
    if (activeVoice(this.settings) === voice) return;
    this.settings = await setSettings({ [voiceKeyFor(this.settings.engine)]: voice });
    await this.reloadEngine();
  }

  // ---- playback control -----------------------------------------------------

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
      await this.scheduler.start(this.playlist.length, this.currentPlayId, this.primeSeconds).catch(() => undefined);
      // start() also flips running=true and primes; if engine not ready yet, nothing is scheduled.
      if (!this.engineReady) return; // will auto-start from onReady
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
      await this.scheduler.start(this.playlist.length, this.currentPlayId, this.primeSeconds).catch(() => undefined);
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
    const keepFrom = this.currentPlayId + 1;
    this.requested.clear();
    this.worker.cancelFrom(keepFrom);
    this.scheduler.reprimeForSpeed();
    this.ensureSynth(keepFrom);
    // Re-synthesising the current sentence at the new rate takes a moment.
    this.state.busy = this.scheduler.isPlaying();
    this.pushState();
  }

  /** Re-initialise the worker for a new engine/voice, keeping the plan and position. */
  async reloadEngine(): Promise<void> {
    this.settings = await getSettings();
    this.refreshBarVoices();
    this.engineReady = false;
    this.requested.clear();
    this.state.modelProgress = 0;
    this.setStatus('loading-model');
    await this.scheduler.dispose();
    this.scheduler = new GaplessScheduler({
      onChunkStart: (id) => this.onChunkStart(id),
      onChunkEnd: (id) => this.onChunkEnd(id),
      onNeedMore: (id) => this.ensureSynth(id),
      onUnderrun: (id) => this.onUnderrun(id),
      onFinished: () => this.onFinished(),
    });
    try {
      await this.worker.init(this.engineConfig());
    } catch (err) {
      this.fail(`Failed to load the voice model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- pipeline glue ------------------------------------------------------

  private ensureSynth(fromPlayId: number): void {
    if (!this.engineReady) return;
    for (let i = fromPlayId; i < Math.min(fromPlayId + this.lookahead + 1, this.playlist.length); i++) {
      if (this.requested.has(i)) continue;
      const item = this.playlist[i];
      if (!item) continue;
      this.requested.add(i);
      this.worker.request(i, item.spokenText, this.settings.speed);
    }
  }

  private onChunkStart(playId: number): void {
    this.currentPlayId = playId;
    const item = this.playlist[playId];
    this.state.currentIndex = playId;
    // Audio is actually flowing — reconcile the UI with reality.
    this.state.busy = false;
    this.state.hint = undefined;
    if (this.wantsPlayback && this.state.status !== 'playing') this.state.status = 'playing';
    if (this.settings.highlight) {
      // Never blank the highlight while audio is playing: fall back to the enclosing block,
      // then to whatever was last shown, so the reader's eye is never left stranded.
      const range = item?.range ?? item?.blockRange ?? this.lastShownRange;
      if (range) this.lastShownRange = range;
      this.highlighter?.show(range);
    }
    this.ensureSynth(playId + 1);
    this.pushState();
  }

  private onChunkEnd(playId: number): void {
    if (playId >= this.playlist.length - 1) return;
    this.ensureSynth(playId + 1);
  }

  private onUnderrun(playId: number): void {
    // Ran out of ready audio mid-playback (common with the slower Kokoro engine). Tell the user.
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

  // ---- state / messaging -------------------------------------------------

  private connectPort(): void {
    try {
      this.port = browser.runtime.connect({ name: PORT_NAME });
      this.port.onMessage.addListener((msg: unknown) => {
        const m = msg as { type?: string };
        if (m.type === 'stop') this.stop('superseded');
        else if (m.type === 'toggle') void (this.scheduler?.isPlaying() ? this.pause() : this.play());
        else if (m.type === 'settings-changed') void this.onSettingsChanged();
        else if (m.type === 'query-state') this.pushState();
      });
      this.port.onDisconnect.addListener(() => (this.port = null));
    } catch (err) {
      log.warn('could not connect to background:', err);
    }
  }

  private async onSettingsChanged(): Promise<void> {
    const prev = this.settings;
    this.settings = await getSettings();
    this.highlighter?.setOptions({
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
    });
    if (prev.tapToSeek !== this.settings.tapToSeek) this.applyTapToSeek();
    const engineChanged =
      prev.engine !== this.settings.engine ||
      prev.piperVoice !== this.settings.piperVoice ||
      prev.kokoroVoice !== this.settings.kokoroVoice ||
      prev.supertonicVoice !== this.settings.supertonicVoice ||
      prev.kokoroDtype !== this.settings.kokoroDtype ||
      prev.supertonicSteps !== this.settings.supertonicSteps ||
      prev.preferWebGPU !== this.settings.preferWebGPU ||
      prev.synthWorkers !== this.settings.synthWorkers;
    if (engineChanged) await this.reloadEngine();
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

  stop(reason: 'user' | 'superseded' | 'navigation'): void {
    log.info('session stop:', reason);
    void this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tapToSeekHandler) {
      document.removeEventListener('click', this.tapToSeekHandler, true);
      this.tapToSeekHandler = null;
    }
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
    // Only clear the global if it still points at us — a replacement session (Read from here /
    // Read selection on a running reader) may already have taken the slot.
    const w = window as unknown as { __aloudSession?: unknown };
    if (w.__aloudSession === this) w.__aloudSession = undefined;
  }
}
