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

import { extractArticle, type ExtractedArticle } from '@/extract/readability';
import { resolveLiveRoot } from '@/extract/live-container';
import { buildTextIndex, rangeForSpan, type TextIndex } from '@/extract/text-index';
import { spokenToSource } from '@/highlight/word-map';
import { normalizeForSpeech } from '@/segment/normalize';
import { applyPronunciations } from '@/segment/pronunciations';
import { GaplessScheduler } from '@/audio/scheduler';
import { Highlighter } from '@/highlight/highlighter';
import { ControlBar, type ExportState } from '@/ui/control-bar';
import { WorkerClient } from '@/engine/worker-client';
import type { EngineConfig, WordTiming } from '@/engine/protocol';
import type { ModelManifest } from '@/engine/engines/types';
import { getSettings, setSettings, activeVoice, voiceKeyFor, type EngineId, type Settings } from '@/shared/settings';
import { ENGINE_IDS } from '@/shared/engine-catalog';
import {
  languageName,
  pickVoiceForLanguage,
  primaryLanguage,
  voiceLanguage,
  type CandidateVoice,
} from '@/shared/language-voice';
import { listVoices, type VoiceOption } from '@/shared/voice-catalog';
import {
  clearPosition,
  documentKey,
  excerptOf,
  loadPosition,
  resumeIndex,
  savePosition,
} from '@/shared/reading-positions';
import { PORT_NAME, type ActivateMode, type SessionState } from '@/shared/messages';
import { siteOf, type DocSource } from '@/shared/doc-source';
import { addNote } from '@/shared/notes';
import { createAnchor, type TextAnchor } from '@/annotate/anchor';
import { anchorForRange } from '@/annotate/page-anchoring';
import { recordListening } from '@/shared/reading-history';
import { log } from '@/shared/log';

import { backendOf, tuningFor, type SynthBackend } from './engine-tuning';
import { loadLastBackend, saveLastBackend, saveWorkerGpu } from '@/shared/backend-memory';
import {
  buildArticlePlaylist,
  buildSelectionPlaylist,
  leadSilenceSec,
  type PlaylistItem,
} from './playlist';
import { firstSentenceInViewport, indexAtPoint, indexNearElement } from './playlist-navigation';
import { TapToSeek } from './tap-to-seek';
import { MediaControls } from './media-session';
import { SleepTimer, type SleepChoice } from './sleep-timer';
import { Mp3Export, audioFileName } from './audio-export';

interface BeginOptions {
  /** For "Read from here": the element that was right-clicked, when the browser can tell us. */
  targetElement?: Element | null;
  /**
   * A document whose structure the caller already knows, supplied instead of guessing at it.
   *
   * The PDF reader builds its own DOM from the PDF's own layout — including the column order
   * Readability cannot see — so asking Readability to re-derive an article from that would only
   * be a chance to get it wrong. Everything downstream (planning, alignment, highlighting) is
   * unchanged; only the "what is the article, and where does it live" step is skipped.
   */
  knownArticle?: KnownArticle | null;
  /**
   * Whether this session may show the one-time tips card above the bar. The walkthrough passes
   * `false`: its demo session exists to *show* the bar, with every one of those tips already
   * spelled out on the page around it, and spending the one-time card there would mean the first
   * real article someone reads gets no explanation at all.
   */
  showTips?: boolean;
  /** Start reading as soon as the voice is ready — the queue page, after its own Play click. */
  autoplay?: boolean;
  /** Called once the whole document has been read, so the queue page can move on. */
  onFinished?: () => void;
  /**
   * How to find this document again from the Library. A web page defaults to its own address;
   * the PDF reader and the queue page say what they are showing.
   */
  source?: Omit<DocSource, 'key' | 'title'> & { title?: string };
  /** False for the walkthrough's demo, which is not something anyone "read". */
  keepHistory?: boolean;
}

export interface KnownArticle {
  /** The element whose visible text is the document, in reading order. */
  root: Element;
  /** The same text the root contains, used to align sentences to the DOM. */
  text: string;
  title: string;
  lang?: string;
  /**
   * Identity for remembering where the reader stopped. Web pages use their URL; a PDF opened from
   * a hand-off or a file picker has an extension-page URL that changes every time, so the PDF
   * reader supplies its own.
   */
  key?: string;
}

/** A selection snapshot, taken before any async work can disturb it. */
interface SelectionSnapshot {
  text: string;
  range: Range | null;
}

/** Below this many characters a selection isn't worth reading — fall back to the whole article. */
const MIN_SELECTION_CHARS = 15;

/** How often, at most, the reading position is written while playing. */
const POSITION_SAVE_INTERVAL_MS = 4000;
/** Reading history is written this often while playing (and always on pause, close and finish). */
const HISTORY_WRITE_INTERVAL_MS = 15_000;
/** A sentence heard for less than this when "save to notes" is pressed gives way to the previous one. */
const JUST_STARTED_SECONDS = 1.2;
/** How much speech "back a little" replays. */
const BACK_A_LITTLE_SECONDS = 10;

/** How far either side of the current sentence to look for one that exists in the DOM. */
const NEARBY_RANGE_SEARCH = 20;

export class ReaderSession {
  // ---- subsystems (built in begin()) --------------------------------------
  private settings!: Settings;
  private scheduler!: GaplessScheduler;
  private worker!: WorkerClient;
  private highlighter: Highlighter | null = null;
  private bar: ControlBar | null = null;
  private tapToSeek: TapToSeek | null = null;
  private media: MediaControls | null = null;
  private sleepTimer: SleepTimer | null = null;
  /** "Save as MP3" while it runs: it has the synthesis workers to itself until it ends. */
  private exporter: Mp3Export | null = null;
  /** The finished MP3, kept until it is saved or discarded. */
  private exportFile: Blob | null = null;
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
  /** The voice a switch is waiting on, so its arrival can be confirmed by name. */
  private pendingVoiceLabel: string | null = null;
  /** The one-time tips card is offered once per session, and only once per profile. */
  private tipsOffered = false;
  private tipsAllowed = true;
  /** Removes the scroll/resize listeners that drive the "snap back" button's state. */
  private stopViewportWatch: (() => void) | null = null;
  /** Coalesces scroll events into one visibility check per frame. */
  private offScreenFrame = 0;
  private currentOffScreen = false;
  /** Sample rate the active engine produces. Used to build the silence that replaces a
   *  sentence which failed to synthesise. */
  private sampleRate = 22050;
  /** Which document this is, for remembering the reading position (`shared/reading-positions`). */
  private docKey = '';
  /** Throttles position saves while reading; the last one is always forced on teardown. */
  private lastPositionSave = 0;
  private lastSavedIndex = -1;
  private outputLogged = false;
  /** When each word of a synthesised sentence is spoken, as the engine reported it (Piper). */
  private readonly wordTimings = new Map<number, WordTiming[]>();
  /** Seconds of speech in each synthesised sentence, lead silence excluded. */
  private readonly audioSeconds = new Map<number, number>();
  private sourceHint: BeginOptions['source'] | null = null;
  private keepHistory = true;
  /** Listening not yet written to history, and what this session has measured of the voice's pace. */
  private listening = { pendingSeconds: 0, spokenChars: 0, spokenSeconds: 0, lastWrite: 0 };
  private charsBefore: number[] | null = null;
  /** The sentence playing now, as page ranges for its words, and the word last marked. */
  private words: { playId: number; spans: Array<{ start: number; range: Range }>; shown: number } | null = null;
  private wordTimer = 0;
  private finishedHook: (() => void) | null = null;
  /**
   * A downloaded voice in the page's language, chosen for this page only (never saved), or null
   * when the saved voice is reading. See `matchVoiceToPage`.
   */
  private languageVoice: CandidateVoice | null = null;
  /** The language the page declares (`<html lang>`), as a hint for detection. */
  private declaredLanguage = '';

  private state: SessionState = {
    status: 'idle',
    currentIndex: 0,
    totalChunks: 0,
    title: '',
    modelProgress: 0,
  };

  // ---- tuning --------------------------------------------------------------

  /**
   * Which path synthesis actually took, straight from the worker's `ready`.
   *
   * Assume the CPU until told otherwise: a machine whose `requestAdapter()` returns null looks
   * identical to a GPU machine from here, and guessing "GPU" gives a stalling reader a queue
   * built for a fast one.
   */
  private backend: SynthBackend = 'cpu';

  private get tuning() {
    return tuningFor(this.engine, this.backend);
  }

  /** The engine actually reading: a page-language voice's, else the saved one. */
  private get engine(): EngineId {
    return this.languageVoice?.engine ?? this.settings.engine;
  }

  /** The voice actually reading: a page-language voice, else the saved one. */
  private get voice(): string {
    return this.languageVoice?.id ?? activeVoice(this.settings);
  }

  // ---- startup -------------------------------------------------------------

  async begin(mode: ActivateMode = 'article', opts: BeginOptions = {}): Promise<void> {
    this.mode = mode;
    this.startTarget = opts.targetElement ?? null;
    this.knownArticle = opts.knownArticle ?? null;
    this.tipsAllowed = opts.showTips ?? true;
    this.finishedHook = opts.onFinished ?? null;
    this.sourceHint = opts.source ?? null;
    this.keepHistory = opts.keepHistory ?? true;
    // Snapshot the page selection *now*, before any await or DOM work can disturb it.
    if (mode === 'selection') this.selection = snapshotSelection();
    // "Read selection" / "Read from here" are explicit "start reading now" actions.
    this.wantsPlayback = mode === 'selection' || mode === 'from-cursor' || opts.autoplay === true;

    this.settings = await getSettings();
    // Chunk sizes are fixed at planning time, before any engine exists, so start from what
    // synthesis did last time on this device rather than from an assumption about the browser.
    this.backend = (await loadLastBackend()) ?? 'cpu';
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

    this.docKey = this.knownArticle?.key ?? documentKey(location.href);
    await this.maybeResume();
    await this.matchVoiceToPage();
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
      onAudio: (playId, pcm, sr, words) => {
        if (this.exporter) {
          this.exporter.accept(playId, pcm, sr);
          return;
        }
        if (sr > 0) this.audioSeconds.set(playId, pcm.length / sr);
        if (words?.length) this.wordTimings.set(playId, words);
        else this.wordTimings.delete(playId);
        this.scheduler.provide(playId, pcm, sr, leadSilenceSec(this.playlist[playId], this.settings));
      },
      onNotice: (message) => {
        // The engine has something to say that is not a failure — most often that it is running
        // on the CPU, and why. Worth a line in the bar: otherwise "slow" is all the user sees.
        log.info('engine notice:', message);
        this.bar?.flash(message);
      },
      onError: ({ message, fatal, stack, playId }) => {
        log.error('worker error:', message, stack ? `\n${stack}` : '');
        if (fatal) this.fail(message);
        else if (playId != null) this.skipSentence(playId);
      },
    });

    this.bar = new ControlBar(document, this.controlCallbacks(), {
      speed: this.settings.speed,
      tapToSeek: this.settings.tapToSeek,
      theme: this.settings.theme,
    });
    void this.refreshBarVoices();
    this.watchViewport();

    this.highlighter = new Highlighter(document, {
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
    });

    this.media = new MediaControls(
      {
        play: () => void this.play(),
        pause: () => void this.pause(),
        previous: () => this.seekBy(-1),
        next: () => this.seekBy(1),
      },
      browser.runtime.getURL('/icon/128.png'),
    );

    this.sleepTimer = new SleepTimer({
      currentIndex: () => this.currentPlayId,
      playlist: () => this.playlist,
      isPlaying: () => this.scheduler.isPlaying(),
      stopAfter: (id) => this.scheduler.stopAfter(id),
      clearStop: () => this.scheduler.clearStopAfter(),
      onChange: (state) => this.bar?.setSleep(state),
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
      onStopReached: () => void this.onSleepStop(),
    });
  }

  private onEngineReady(executionProvider: string, sampleRate: number): void {
    this.engineReady = true;
    this.sampleRate = sampleRate;
    this.state.engineInfo = executionProvider;
    // The provider is the only honest answer to "is this machine fast?", and it decides how deep
    // the queue runs from here on (`tuning`). Chunk sizes were already fixed at planning time,
    // so only lookahead / prime length change — which is exactly what stops the CPU path from
    // running dry between sentences.
    this.backend = backendOf(executionProvider);
    void saveLastBackend(this.backend);
    // Positive evidence only: a session that ran on WASM proves nothing about the GPU (Piper
    // never asks for one, and the user may have switched acceleration off), but a session that
    // ran on WebGPU proves the worker can reach it — which is how a Firefox user who turned on
    // the about:config prefs stops being told their browser has no GPU access.
    if (executionProvider.startsWith('webgpu')) void saveWorkerGpu(true);
    log.info('engine ready', executionProvider, `${sampleRate}Hz`, `→ ${this.backend} tuning`);
    this.setStatus(this.wantsPlayback ? 'playing' : 'paused');
    if (this.pendingVoiceLabel) {
      this.bar?.flash(`${this.pendingVoiceLabel} ready`, 'ok');
      this.pendingVoiceLabel = null;
    }
    this.maybeShowTips();
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
      // Closing the tab, pressing ✕ or starting another reader mid-load disposes the worker, which
      // rejects this init. That is the user's choice, not a failure — logging it as one only
      // buried the real errors.
      if (this.disposed) return;
      this.fail(`Failed to load the voice model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- extraction & planning ----------------------------------------------

  /**
   * Page text → spoken text. The reader's own pronunciation rules run first, on the text as
   * written, so "e.g." or "GPU" can be given a reading before the built-in expansions see them.
   */
  private normalize = (text: string): string => {
    const fixed = applyPronunciations(text, this.settings.pronunciations);
    return normalizeForSpeech(fixed, {
      urlReplacement: this.settings.skipUrls ? 'link' : fixed,
      expandAbbreviations: this.settings.expandAbbreviations,
    });
  };

  /**
   * Rebuild every sentence's spoken text after a change to how text is spoken, and re-synthesise
   * from the next sentence on — the same seam a speed change uses, so the sentence playing now
   * finishes as it was and the change is heard straight after it.
   */
  private respeak(): void {
    for (const item of this.playlist) item.spokenText = this.normalize(item.sourceText);
    this.cancelExport('How words are spoken changed, so the MP3 was stopped');
    if (!this.engineReady) return;
    const keepFrom = this.currentPlayId + 1;
    this.requested.clear();
    this.worker.cancelFrom(keepFrom, 0);
    this.scheduler.reprimeForSpeed();
    this.ensureSynth(keepFrom);
    this.pushState();
  }

  private knownArticle: KnownArticle | null = null;

  private extractAndPlan(): void {
    const known = this.knownArticle;
    const article: ExtractedArticle = known
      ? { title: known.title, text: known.text, lang: known.lang ?? 'en', byline: null, html: '', readerable: true }
      : extractArticle(document);
    this.state.title = article.title || document.title;
    // A known article (the PDF reader) inherits the *reader page's* lang, which says nothing about
    // the document, so only a real page's declaration is kept as a hint.
    this.declaredLanguage = known ? '' : article.lang;

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
      const liveRoot = known ? known.root : resolveLiveRoot(article, document);
      this.textIndex = buildTextIndex(liveRoot);
      this.playlist = buildArticlePlaylist({
        index: this.textIndex,
        lang: article.lang,
        maxChars: this.tuning.maxChars,
        normalize: this.normalize,
        referenceText: article.text,
        title: this.state.title,
        // A whole-page read passes over code, tables, … as configured. "Read from here" is aimed
        // at a specific place, so it still skips — the aim picks where to start, not what to read.
        skip: this.settings.skip,
      });
    }

    this.state.totalChunks = this.playlist.length;
    if (this.mode === 'from-cursor') this.startFromCursor();
    this.logPlan();
    this.refreshMediaMetadata();
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
      onSnapToCurrent: () => this.snapToCurrent(),
      onSaveNote: () => void this.saveNote(),
      onBackALittle: () => this.backALittle(),
      onSleep: (choice: SleepChoice) => this.setSleep(choice),
      onExportStart: () => void this.startExport(),
      onExportCancel: () => this.cancelExport(),
      onExportSave: () => this.saveExport(),
      onOpenSettings: () => this.port?.postMessage({ type: 'open-options' }),
      onOpenWalkthrough: () => this.port?.postMessage({ type: 'open-walkthrough' }),
      onTipsDismissed: () => void setSettings({ tipsSeen: true }),
      onClose: () => this.stop('user'),
    };
  }

  async play(): Promise<void> {
    if (this.exporter) {
      this.bar?.flash('Reading carries on once the MP3 is made', 'info');
      return;
    }
    // Pressing play after the sleep timer stopped the reader carries on past where it stopped.
    if (!this.sleepTimer?.isArmed()) this.scheduler?.clearStopAfter();
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
    if (this.words) this.followWords();

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
    this.stopFollowingWords(false);
    this.recordHistory(this.currentPlayId);
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
    if (this.exporter) {
      this.bar?.flash('Reading carries on once the MP3 is made', 'info');
      return;
    }
    const target = Math.max(0, Math.min(playId, this.playlist.length - 1));
    this.currentPlayId = target;
    this.state.currentIndex = target;
    this.highlighter?.show(this.playlist[target]?.range ?? null);

    // The worker drops its whole queue on cancel; clear our matching bookkeeping so ensureSynth
    // actually re-requests the sentences around the new position (even if we've been here before).
    // Work already running on a sentence in the new window is kept — it is about to be asked for
    // again on the very next line.
    this.requested.clear();
    this.worker.cancelFrom(target, this.tuning.lookahead + 1);
    this.scheduler.seek(target);
    this.stopFollowingWords(true);
    // A "stop at the end of this paragraph" timer now means the paragraph just jumped to.
    this.sleepTimer?.onSeek();
    if (this.engineReady) this.ensureSynth(target);
    // Playback has to wait for the new sentence to synthesise; show that.
    this.state.busy = this.engineReady && this.scheduler.isPlaying();
    this.pushState();
    this.bar?.flash(`Sentence ${target + 1} of ${this.playlist.length}`);
    this.refreshOffScreen();
  }

  async setSpeed(speed: number): Promise<void> {
    this.settings = await setSettings({ speed });
    this.cancelExport('The speed changed, so the MP3 was stopped');
    this.bar?.setSpeed(speed);
    this.bar?.flash(`Speed ${speed}×`);
    if (!this.engineReady) return;
    // The sentence already playing keeps its old rate; everything after it is re-synthesised.
    const keepFrom = this.currentPlayId + 1;
    this.requested.clear();
    // Nothing in flight survives a speed change: every sentence has to be spoken at the new rate.
    this.worker.cancelFrom(keepFrom, 0);
    this.scheduler.reprimeForSpeed();
    this.ensureSynth(keepFrom);
    this.state.busy = this.scheduler.isPlaying();
    this.pushState();
  }

  // ---- engine & voice ------------------------------------------------------

  private engineConfig(): EngineConfig {
    return {
      engine: this.engine,
      voice: this.voice,
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
  private async refreshBarVoices(): Promise<void> {
    if (!this.bar || !this.manifest) return;
    const current = this.voice;
    const installed = await this.installedVoices();

    const shown = [...installed];
    if (!shown.some((v) => v.id === current)) {
      // A <select> must be able to show its own value, so the active voice is always listed —
      // labelled, when it is not on the device yet, so picking anything else is the obvious move.
      const known = listVoices(this.engine, this.manifest).find((v) => v.id === current);
      shown.unshift({
        id: current,
        label: `${known?.label ?? current} · not downloaded yet`,
        group: known?.group ?? '',
      });
    }

    this.bar.setVoices(shown, current, { downloadedOnly: installed.length > 0 });
  }

  /**
   * The voices of the active engine that are downloaded, asked of the background.
   *
   * The bar used to list all 175 Piper voices from the manifest, so switching voice mid-article
   * could silently start a 60 MB download and stall the reader. Only the background can answer
   * this: the model cache is IndexedDB at the *extension* origin, and this code runs in the page.
   */
  private async installedVoices(engine: EngineId = this.engine): Promise<VoiceOption[]> {
    try {
      const reply = await browser.runtime.sendMessage({ type: 'installed-voices', engine });
      return Array.isArray(reply) ? (reply as VoiceOption[]) : [];
    } catch (err) {
      log.warn('could not list installed voices:', err);
      return [];
    }
  }

  /** Switch voice from the in-page bar, keeping the plan and position. */
  private async changeVoice(voice: string): Promise<void> {
    if (this.voice === voice) return;
    // Named, not just "switching": the picker collapses the moment it is used, so the
    // confirmation is the only thing left saying which voice was chosen.
    this.pendingVoiceLabel = this.voiceLabel(voice);
    this.bar?.flash(`Switching to ${this.pendingVoiceLabel}…`);
    if (this.languageVoice) {
      // Picked while a page-language voice is reading: another voice for *this page*, not a new
      // default — reading one French article must not make every page French.
      this.languageVoice = {
        ...this.languageVoice,
        id: voice,
        label: this.pendingVoiceLabel,
        language: this.manifest ? voiceLanguage(this.languageVoice.engine, voice, this.manifest) : this.languageVoice.language,
      };
    } else {
      this.settings = await setSettings({ [voiceKeyFor(this.settings.engine)]: voice });
    }
    await this.reloadEngine();
  }

  /** The human name of a voice id for the active engine, falling back to the id itself. */
  private voiceLabel(voice: string): string {
    if (!this.manifest) return voice;
    return listVoices(this.engine, this.manifest).find((v) => v.id === voice)?.label ?? voice;
  }

  /** Re-initialise the worker for a new engine/voice, keeping the plan and position. */
  async reloadEngine(): Promise<void> {
    this.settings = await getSettings();
    this.cancelExport('The voice changed, so the MP3 was stopped');
    await this.refreshBarVoices();
    this.engineReady = false;
    this.requested.clear();
    this.state.modelProgress = 0;
    await this.scheduler.dispose();
    this.scheduler = this.createScheduler();
    this.sleepTimer?.onSeek();
    this.refreshMediaMetadata();
    await this.loadEngine();
  }

  // ---- sleep timer & media controls ----------------------------------------

  private setSleep(choice: SleepChoice): void {
    this.sleepTimer?.set(choice);
    const said: Record<string, string> = {
      off: 'Sleep timer off',
      paragraph: 'Stopping at the end of this paragraph',
      section: 'Stopping at the end of this section',
    };
    this.bar?.flash(typeof choice === 'number' ? `Stopping in ${choice} minutes` : said[choice]!, 'ok');
  }

  /** The sleep timer's stop point has finished playing. */
  private async onSleepStop(): Promise<void> {
    this.sleepTimer?.onStopReached();
    await this.pause();
    this.bar?.flash('Sleep timer — stopped here. Press play to carry on.', 'ok');
  }

  /** Title, voice and site for the OS media overlay and the lock screen. */
  private refreshMediaMetadata(): void {
    let site = '';
    try {
      site = location.protocol.startsWith('http') ? location.hostname : '';
    } catch {
      /* no location worth showing */
    }
    this.media?.setMetadata(this.state.title, this.voiceLabel(this.voice), site);
  }

  // ---- save as MP3 ---------------------------------------------------------

  /**
   * Make the whole document into one MP3 with the loaded voice.
   *
   * Reading pauses and the export takes the synthesis workers over, so the file is made as fast
   * as this machine can synthesise; playback's own queue is dropped and rebuilt afterwards.
   */
  private async startExport(): Promise<void> {
    if (this.exporter || this.playlist.length === 0) return;
    if (!this.engineReady) {
      this.setExport({ phase: 'error', message: 'The voice is still loading — try again in a moment.' });
      return;
    }
    this.exportFile = null;
    await this.pause();
    this.requested.clear();
    this.worker.cancelFrom(0, 0);
    const started = performance.now();
    const exporter = new Mp3Export({
      count: this.playlist.length,
      // Deep enough to keep every worker in the pool busy, which is all that decides the pace.
      lookahead: Math.max(4, this.tuning.lookahead),
      request: (id) => this.worker.request(id, this.playlist[id]!.spokenText, this.settings.speed),
      leadSilenceSec: (id) => (id === 0 ? 0 : leadSilenceSec(this.playlist[id], this.settings)),
      onProgress: (done, total) => {
        if (this.exporter === exporter) this.setExport({ phase: 'running', done, total });
      },
      onDone: (file, seconds) => {
        if (this.exporter !== exporter) return;
        log.info(
          `mp3 export: ${this.playlist.length} sentences → ${seconds.toFixed(1)}s audio, ` +
            `${(file.size / 1e6).toFixed(2)} MB in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
        this.exportFile = file;
        this.endExport();
        this.setExport({ phase: 'done', seconds, bytes: file.size });
        this.bar?.flash('MP3 ready — press the save button to keep it', 'ok');
      },
      onError: (message) => {
        if (this.exporter !== exporter) return;
        log.warn('mp3 export failed:', message);
        this.endExport();
        this.setExport({ phase: 'error', message });
      },
    });
    this.exporter = exporter;
    log.info(`mp3 export: ${this.playlist.length} sentences`);
    exporter.start();
  }

  /** Stop an export in progress (or drop a finished file). `why` is said when one was running. */
  private cancelExport(why?: string): void {
    const running = this.exporter;
    this.exportFile = null;
    if (running) {
      running.cancel();
      this.endExport();
      if (why) this.bar?.flash(why);
    }
    this.setExport({ phase: 'idle' });
  }

  /** Give the workers back to playback, queued from where reading had got to. */
  private endExport(): void {
    this.exporter = null;
    this.requested.clear();
    this.worker.cancelFrom(this.currentPlayId, 0);
    this.scheduler.seek(this.currentPlayId);
    this.ensureSynth(this.currentPlayId);
  }

  private setExport(state: ExportState): void {
    this.bar?.setExport(state);
  }

  /** Download the finished MP3. Runs inside the click on "Save file". */
  private saveExport(): void {
    const file = this.exportFile;
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = audioFileName(this.state.title);
    a.style.display = 'none';
    (document.body ?? document.documentElement).appendChild(a);
    a.click();
    a.remove();
    // The download has taken its own reference by now; a minute is generous for slow disks.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ---- the page's language -------------------------------------------------

  /**
   * Read this page with a downloaded voice in its language, if the current voice speaks another.
   *
   * Only for this page, never saved. When no downloaded voice fits, say so once and offer the way
   * to get one, rather than reading French with English pronunciation in silence.
   */
  private async matchVoiceToPage(): Promise<void> {
    this.languageVoice = null;
    const manifest = this.manifest;
    if (!this.settings.matchPageLanguage || !manifest || this.playlist.length === 0) return;

    const language = await this.detectPageLanguage();
    if (!language) return;

    const savedEngine = this.settings.engine;
    const savedId = activeVoice(this.settings);
    const saved: CandidateVoice = {
      engine: savedEngine,
      id: savedId,
      label: this.voiceLabel(savedId),
      language: voiceLanguage(savedEngine, savedId, manifest),
    };
    if (primaryLanguage(saved.language) === primaryLanguage(language)) return;

    const installed = (
      await Promise.all(
        ENGINE_IDS.map(async (engine) =>
          (await this.installedVoices(engine)).map((v) => ({
            engine,
            id: v.id,
            label: v.label,
            language: voiceLanguage(engine, v.id, manifest),
          })),
        ),
      )
    ).flat();

    const pick = pickVoiceForLanguage(language, saved, installed);
    const name = languageName(primaryLanguage(language));
    if (pick) {
      this.languageVoice = pick;
      log.info(`page language ${language}: reading with ${pick.engine}/${pick.id} instead of ${saved.id}`);
      this.bar?.flash(`This page is in ${name} — reading it with ${pick.label}`, 'ok');
      void this.refreshBarVoices();
      this.refreshMediaMetadata();
    } else {
      log.info(`page language ${language}: no downloaded voice for it`);
      this.bar?.flash(`This page is in ${name}, and no ${name} voice is downloaded`, 'info', {
        label: 'Get one',
        run: () => this.port?.postMessage({ type: 'open-options' }),
      });
    }
  }

  /**
   * The page's language: the browser's own detector when it is sure, else the page's declared
   * language when the detector does not contradict it. `<html lang>` alone is not trusted — CMS
   * templates ship `lang="en"` on pages in every language.
   */
  private async detectPageLanguage(): Promise<string> {
    const sample = this.playlist
      .slice(0, 60)
      .map((p) => p.sourceText)
      .join(' ')
      .slice(0, 2500);
    let detected = '';
    let reliable = false;
    try {
      const result = await browser.i18n.detectLanguage(sample);
      const top = result.languages?.[0];
      if (top && top.language && top.language !== 'und') {
        detected = top.language;
        reliable = Boolean(result.isReliable) && top.percentage >= 60;
      }
    } catch {
      /* no detector in this browser or context */
    }
    if (reliable) return detected;
    const declared = this.declaredLanguage;
    if (declared && (!detected || primaryLanguage(detected) === primaryLanguage(declared))) return declared;
    return '';
  }

  // ---- pipeline glue -------------------------------------------------------

  /** Keep the worker queue topped up from `fromPlayId` for the current engine's lookahead. */
  private ensureSynth(fromPlayId: number): void {
    if (!this.engineReady || this.exporter) return;
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
    if (!this.outputLogged) {
      // Which path the audio took decides whether media keys and the OS overlay can reach us.
      this.outputLogged = true;
      log.info(`audio output: ${this.scheduler.routesThroughMediaElement ? 'media element (media keys enabled)' : 'direct'}`);
    }
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

    this.prepareWords(playId);
    this.ensureSynth(playId + 1);
    this.pushState();
    this.refreshOffScreen();
    this.maybeShowTips();
    this.rememberPosition(playId);
    if (Date.now() - this.listening.lastWrite > HISTORY_WRITE_INTERVAL_MS) this.recordHistory(playId);
  }

  // ---- word highlighting ----------------------------------------------------

  /**
   * Turn the playing sentence's word timings into page ranges, and start following the audio.
   *
   * A word lights from the moment its first sound plays until the next word's does, so the mark
   * rests on the last word through a comma's pause rather than blinking off. Sentences without
   * timings (other engines, a title that is spoken but not on the page) keep the sentence
   * highlight alone.
   */
  private prepareWords(playId: number): void {
    for (const id of this.wordTimings.keys()) if (id < playId - 1) this.wordTimings.delete(id);
    this.highlighter?.showWord(null);
    this.words = null;

    const item = this.playlist[playId];
    const timings = this.wordTimings.get(playId);
    const index = this.textIndex;
    if (!this.settings.highlight || !this.settings.wordHighlight || !this.highlighter?.canShowWords) return;
    if (!item || !timings || item.sourceAt == null || !index) return;

    const toSource = spokenToSource(item.spokenText, item.sourceText);
    const spans: Array<{ start: number; range: Range }> = [];
    for (const word of timings) {
      const span = toSource(word.from, word.to);
      const range = span && rangeForSpan(index, item.sourceAt + span[0], item.sourceAt + span[1]);
      // Two spoken words on one page word ("e.g." said as "for example") keep the first start.
      const previous = spans[spans.length - 1];
      if (range && !(previous && sameRange(previous.range, range))) {
        spans.push({ start: word.start, range });
      }
    }
    if (spans.length === 0) return;
    this.words = { playId, spans, shown: -1 };
    this.followWords();
  }

  /**
   * Move the mark as the audio clock passes each word. A timer aimed at the next word's start
   * rather than a per-frame loop: a dozen wake-ups a second instead of sixty, and no dependence on
   * how often the page manages to paint. It re-reads the clock on every wake-up, so a late timer
   * never lets the mark drift.
   */
  private followWords(): void {
    // Always restart: a timer still pending from the previous sentence may be aimed a quarter of
    // a second out, long enough to miss a short first word ("The") entirely.
    clearTimeout(this.wordTimer);
    this.wordTimer = 0;
    const tick = (): void => {
      this.wordTimer = 0;
      const words = this.words;
      if (!words || this.disposed) return;
      // Until the audio clock reaches this sentence (it is announced a little early, and output
      // latency delays it further), look again soon rather than at the usual resync interval.
      let wait = 0.03;
      const position = this.scheduler.playbackPosition();
      if (position && position.playId === words.playId) {
        // A few milliseconds early reads as in time; late reads as lagging.
        const t = position.seconds + 0.04;
        let index = -1;
        while (index + 1 < words.spans.length && words.spans[index + 1]!.start <= t) index++;
        if (index !== words.shown) {
          words.shown = index;
          this.highlighter?.showWord(index >= 0 ? words.spans[index]!.range : null);
        }
        const next = words.spans[index + 1];
        wait = next ? next.start - t : 0.25;
      }
      if (this.scheduler.isPlaying()) {
        this.wordTimer = window.setTimeout(tick, Math.round(Math.min(0.25, Math.max(0.012, wait)) * 1000));
      }
    };
    tick();
  }

  private stopFollowingWords(clear: boolean): void {
    clearTimeout(this.wordTimer);
    this.wordTimer = 0;
    if (clear) {
      this.words = null;
      this.highlighter?.showWord(null);
    }
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
    // Left in `requested` on purpose: removing it made the very next top-up ask for the same
    // sentence again, which failed the same way — two or three doomed requests per sentence.
    // A seek clears `requested`, so jumping back to it still gives it a fresh try.
    if (this.exporter) this.exporter.accept(playId, new Float32Array(0), this.sampleRate);
    else this.scheduler.provide(playId, new Float32Array(0), this.sampleRate, 0);
  }

  private onChunkEnd(playId: number): void {
    const seconds = this.audioSeconds.get(playId) ?? 0;
    this.listening.pendingSeconds += seconds;
    if (seconds > 0) {
      this.listening.spokenSeconds += seconds;
      this.listening.spokenChars += this.playlist[playId]?.spokenText.length ?? 0;
    }
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
    this.stopFollowingWords(true);
    this.wantsPlayback = false;
    this.state.busy = false;
    this.highlighter?.clear();
    this.currentPlayId = 0;
    this.state.currentIndex = this.playlist.length;
    this.setStatus('paused');
    this.bar?.flash('Finished reading this page', 'ok');
    this.bar?.setCurrentOffScreen(false);
    // Read to the end: next time it opens at the top, not at the last sentence.
    this.lastSavedIndex = -1;
    if (this.docKey) void clearPosition(this.docKey);
    this.recordHistory(this.playlist.length, true);
    this.finishedHook?.();
  }

  // ---- the Library: history, notes, finding your place ------------------------

  /** This document, as the Library will know it. */
  private docSource(): DocSource {
    const hint = this.sourceHint;
    return {
      key: this.docKey,
      title: hint?.title ?? this.state.title ?? document.title,
      site: hint?.site ?? siteOf(location.href),
      reopen: hint?.reopen ?? { kind: 'web', url: location.href },
    };
  }

  /**
   * Write this session's listening to history: where it has got to, what is left, and time heard
   * since the last write. Nothing is recorded for a document nobody has listened to yet.
   */
  private recordHistory(index: number, finished = false): void {
    const { listening } = this;
    if (!this.keepHistory || !this.docKey || this.playlist.length === 0 || this.mode === 'selection') return;
    if (listening.pendingSeconds <= 0 && !finished) return;
    if (!this.charsBefore) {
      let sum = 0;
      this.charsBefore = this.playlist.map((item) => {
        const before = sum;
        sum += item.spokenText.length;
        return before;
      });
      this.charsBefore.push(sum);
    }
    const at = Math.max(0, Math.min(index, this.playlist.length));
    listening.lastWrite = Date.now();
    void recordListening({
      source: this.docSource(),
      index: at,
      total: this.playlist.length,
      charsRead: this.charsBefore[at]!,
      charsTotal: this.charsBefore[this.playlist.length]!,
      addSeconds: listening.pendingSeconds,
      secondsPerChar: listening.spokenChars > 200 ? listening.spokenSeconds / listening.spokenChars : null,
      finished,
      now: listening.lastWrite,
    });
    listening.pendingSeconds = 0;
  }

  /**
   * Keep a passage in Notes: the selected text if there is any, else the sentence being heard.
   *
   * Someone presses the key *after* hearing what they want to keep, so a sentence that has only
   * just begun gives way to the one before it — the one they were reacting to.
   */
  async saveNote(): Promise<void> {
    if (this.playlist.length === 0 || !this.docKey) return;
    const selected = document.getSelection();
    const selectedText = selected && !selected.isCollapsed ? selected.toString().replace(/\s+/g, ' ').trim() : '';

    let index = this.currentPlayId;
    let text = '';
    let anchor: TextAnchor | null = null;
    if (selectedText.length > 1) {
      text = selectedText;
      const range = selected!.getRangeAt(0);
      const node = range.startContainer;
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      if (element) index = indexNearElement(this.playlist, element);
      if (this.textIndex) anchor = anchorForRange(this.textIndex, range)?.anchor ?? null;
    } else {
      const position = this.scheduler?.playbackPosition();
      if (position && position.playId === index && position.seconds < JUST_STARTED_SECONDS && index > 0) index--;
      const item = this.playlist[index];
      text = item?.sourceText.replace(/\s+/g, ' ').trim() ?? '';
      if (item && item.sourceAt != null && this.textIndex) {
        anchor = createAnchor(this.textIndex.fullText, item.sourceAt, item.sourceAt + item.sourceText.length);
      }
    }
    if (!text) return;
    // Anchors are for highlighting web pages again; Aloud's own pages (the PDF reader, the
    // Library's queue) keep their notes by position instead.
    const onWebPage = location.protocol === 'http:' || location.protocol === 'https:';

    try {
      const { duplicate } = await addNote({
        text,
        source: this.docSource(),
        at: { index, total: this.playlist.length, excerpt: excerptOf(this.playlist[index]?.spokenText ?? '') },
        ...(onWebPage && anchor ? { anchor, color: 'yellow', tags: [] } : {}),
      });
      this.bar?.flash(duplicate ? 'Already in your notes' : 'Saved to Notes', 'ok', {
        label: 'Open',
        run: () => this.port?.postMessage({ type: 'open-library', tab: 'notes' }),
      });
    } catch (err) {
      log.warn('could not save the note:', err);
      this.bar?.flash('Could not save that note');
    }
  }

  /**
   * "I drifted off": go back about ten seconds of speech, to the start of a sentence, and show it.
   * Pressing it again goes back further.
   */
  backALittle(): void {
    if (this.playlist.length === 0) return;
    const from = this.currentPlayId;
    let target = from;
    let seconds = this.scheduler?.playbackPosition()?.seconds ?? 0;
    while (target > 0 && seconds < BACK_A_LITTLE_SECONDS) {
      target--;
      seconds += this.audioSeconds.get(target) ?? (this.playlist[target]?.spokenText.length ?? 0) / 14;
    }
    const wasPlaying = this.scheduler?.isPlaying() ?? false;
    this.seekTo(target);
    this.snapToCurrent();
    const excerpt = (this.playlist[target]?.sourceText ?? '').replace(/\s+/g, ' ').trim();
    this.bar?.flash(`Back to “${excerpt.length > 60 ? `${excerpt.slice(0, 57).trimEnd()}…` : excerpt}”`, 'ok');
    if (wasPlaying && !this.scheduler.isPlaying()) void this.play();
  }

  // ---- remembering where we stopped ----------------------------------------

  /**
   * Start where the reader left off last time, if there is a trustworthy place to start.
   *
   * Only for a plain "read this page" activation: "Read from here" and "Read selection" name
   * their own starting point, and overriding that with an old one would be wrong. Playback is
   * not started — the reader lands on the sentence, highlighted, with a one-click way back to the
   * top — because the page might have been reopened to *look* at, not to listen.
   */
  private async maybeResume(): Promise<void> {
    if (this.mode !== 'article' || this.currentPlayId > 0 || !this.docKey) return;
    const saved = await loadPosition(this.docKey);
    const at = resumeIndex(saved, this.playlist.map((p) => p.spokenText));
    if (at == null) return;

    this.currentPlayId = at;
    this.state.currentIndex = at;
    this.lastSavedIndex = at;
    this.highlighter?.show(this.rangeOf(at));
    this.bar?.flash(`Picking up where you left off — sentence ${at + 1} of ${this.playlist.length}`, 'info', {
      label: 'Start over',
      run: () => this.seekTo(0),
    });
    log.info(`resuming at sentence ${at} of ${this.playlist.length}`);
  }

  /** Save the position, at most every few seconds while reading; `force` for teardown. */
  private rememberPosition(index: number, force = false): void {
    if (!this.docKey || this.playlist.length === 0 || index === this.lastSavedIndex) return;
    const now = Date.now();
    if (!force && now - this.lastPositionSave < POSITION_SAVE_INTERVAL_MS) return;
    this.lastPositionSave = now;
    this.lastSavedIndex = index;
    void savePosition(this.docKey, {
      index,
      total: this.playlist.length,
      excerpt: excerptOf(this.playlist[index]?.spokenText ?? ''),
      savedAt: now,
    });
  }

  // ---- settings ------------------------------------------------------------

  /** Persist the click-to-jump toggle (flipped from the in-page bar) and apply it live. */
  private async setTapToSeek(on: boolean): Promise<void> {
    this.settings = await setSettings({ tapToSeek: on });
    this.tapToSeek?.setEnabled(on);
    this.bar?.setTapToSeek(on);
    this.bar?.flash(
      on ? 'Click-to-jump on — click any sentence to jump there' : 'Click-to-jump off',
      on ? 'ok' : 'info',
    );
  }

  private async onSettingsChanged(): Promise<void> {
    const prev = this.settings;
    const prevEngine = engineIdentity(this.engineConfig());
    this.settings = await getSettings();

    if (prev.matchPageLanguage !== this.settings.matchPageLanguage) {
      if (this.settings.matchPageLanguage) await this.matchVoiceToPage();
      else this.languageVoice = null;
    }

    this.highlighter?.setOptions({
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
    });
    if (!this.settings.highlight || !this.settings.wordHighlight) this.stopFollowingWords(true);
    else if (!prev.wordHighlight && this.scheduler?.isPlaying()) this.prepareWords(this.currentPlayId);
    if (prev.tapToSeek !== this.settings.tapToSeek) {
      this.tapToSeek?.setEnabled(this.settings.tapToSeek);
      this.bar?.setTapToSeek(this.settings.tapToSeek);
    }
    if (prev.speed !== this.settings.speed) this.bar?.setSpeed(this.settings.speed);
    if (prev.theme !== this.settings.theme) this.bar?.setTheme(this.settings.theme);

    if (!sameValue(prev.skip, this.settings.skip)) {
      // Skipping changes which sentences exist, not how they sound, so it cannot be patched into
      // a plan that is already playing without renumbering everything under the listener's feet.
      this.bar?.flash('Skip settings apply the next time you start reading', 'ok');
    }

    const respoken = changesSpokenText(prev, this.settings);
    if (respoken) {
      this.respeak();
      this.bar?.flash('Pronunciation updated — from the next sentence', 'ok');
    }

    // Compare what the engine would *load*, not which settings moved: a saved voice change does
    // not touch a page read with a page-language voice, while a precision or worker change does.
    if (engineIdentity(this.engineConfig()) !== prevEngine) {
      this.pendingVoiceLabel = this.voiceLabel(this.voice);
      this.bar?.flash(`Loading ${this.pendingVoiceLabel}…`);
      await this.reloadEngine();
    } else if (!respoken && changedVisibly(prev, this.settings)) {
      // Only for changes that came from somewhere else — the bar's own controls confirm
      // themselves as they are used, and `this.settings` is already up to date by the time the
      // relayed change arrives, so those produce no second message.
      this.bar?.flash('Settings updated', 'ok');
    }
  }

  // ---- following the reader ------------------------------------------------

  /** The DOM range of one playlist item: its own, or the block it sits in. */
  private rangeOf(index: number): Range | null {
    const item = this.playlist[index];
    return item?.range ?? item?.blockRange ?? null;
  }

  /**
   * Where the reader is, on the page — the current sentence's range, or the nearest one that
   * exists.
   *
   * Not every item has a home in the DOM. The first chunk is the article's *title*, which is
   * synthesised from metadata and often matches no text node at all, and a sentence the aligner
   * could not place has no range either. Refusing to scroll in those cases is what made the snap
   * button do nothing at all before playback had started — the commonest moment to press it.
   * Looking a few items either way lands the reader within a paragraph of the truth, which is
   * the whole point of the button.
   */
  private currentRange(): Range | null {
    const own = this.rangeOf(this.currentPlayId);
    if (own) return own;
    for (let step = 1; step <= NEARBY_RANGE_SEARCH; step++) {
      // Forward first: that is where the reading is heading.
      const ahead = this.rangeOf(this.currentPlayId + step);
      if (ahead) return ahead;
      const behind = this.rangeOf(this.currentPlayId - step);
      if (behind) return behind;
    }
    return this.lastShownRange;
  }

  /**
   * "Take me back to what is being read" — the bar's snap button.
   *
   * Scrolls unconditionally, whatever the follow-the-reader setting says: someone who has just
   * pressed the button has asked for this one scroll, and "don't scroll" was about the automatic
   * ones. The confirmation names the sentence, so pressing it while already there still tells
   * the user something rather than looking inert.
   */
  private snapToCurrent(): void {
    const range = this.currentRange();
    if (!this.highlighter?.reveal(range)) {
      this.bar?.flash('There is nothing on this page to scroll to');
      return;
    }
    // Only re-paint the highlight when the range really is this sentence's. When it is a
    // neighbour standing in for a sentence with no place in the DOM, moving the highlight there
    // would point at text that is not being spoken.
    if (this.rangeOf(this.currentPlayId)) this.highlighter.show(range);
    this.bar?.flash(`Sentence ${this.currentPlayId + 1} of ${this.playlist.length}`, 'ok');
    // The scroll is smooth, so the sentence is not on screen yet; re-check once it lands.
    setTimeout(() => this.refreshOffScreen(), 600);
  }

  /**
   * Keep the snap button lit while the sentence being read is off screen.
   *
   * Scrolling away from the reader is the one situation where a control has to advertise itself:
   * nothing else on the page says "Aloud can take you back". Checks are coalesced into one per
   * animation frame, because scroll events arrive far faster than layout answers change.
   */
  private watchViewport(): void {
    const view = document.defaultView;
    if (!view) return;
    const onChange = (): void => {
      if (this.offScreenFrame) return;
      this.offScreenFrame = view.requestAnimationFrame(() => {
        this.offScreenFrame = 0;
        this.refreshOffScreen();
      });
    };
    view.addEventListener('scroll', onChange, { passive: true, capture: true });
    view.addEventListener('resize', onChange, { passive: true });
    this.stopViewportWatch = () => {
      if (this.offScreenFrame) view.cancelAnimationFrame(this.offScreenFrame);
      view.removeEventListener('scroll', onChange, { capture: true });
      view.removeEventListener('resize', onChange);
    };
  }

  private refreshOffScreen(): void {
    if (this.disposed) return;
    const range = this.currentRange();
    const view = document.defaultView;
    if (!range || !view) return;
    const rect = range.getBoundingClientRect();
    // A zero box is a sentence with no layout (display:none, a collapsed section): not something
    // the user can be "away from", so leave the button quiet.
    const offScreen =
      (rect.width !== 0 || rect.height !== 0) && (rect.bottom < 0 || rect.top > view.innerHeight);
    if (offScreen === this.currentOffScreen) return;
    this.currentOffScreen = offScreen;
    this.bar?.setCurrentOffScreen(offScreen);
  }

  /**
   * Offer the one-time tips card the first time a reader gets past the waiting.
   *
   * Deliberately not at start-up: while the voice loads, the space above the bar is carrying
   * "Loading voice… 40%", and burying that behind a tutorial would trade the feedback someone
   * needs now for an explanation they need once.
   */
  private maybeShowTips(): void {
    if (!this.tipsAllowed || this.tipsOffered || this.settings.tipsSeen || this.disposed) return;
    this.tipsOffered = true;
    this.bar?.showTips();
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
        else if (m.type === 'save-note') void this.saveNote();
        else if (m.type === 'back-a-little') this.backALittle();
        else if (m.type === 'flash' && typeof (m as { text?: unknown }).text === 'string') {
          this.bar?.flash((m as { text: string }).text, 'ok');
        }
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
    this.media?.setPlaying(this.state.status === 'playing' ? 'playing' : 'paused');
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
    // Before `disposed` is set: the final position is the one that matters most — it is where
    // the tab was closed or the reader was stopped.
    if (this.engineReady || this.currentPlayId > 0) this.rememberPosition(this.currentPlayId, true);
    this.recordHistory(this.currentPlayId);
    this.disposed = true;

    this.stopFollowingWords(false);
    this.tapToSeek?.dispose();
    this.sleepTimer?.dispose();
    this.exporter?.cancel();
    this.exporter = null;
    this.media?.dispose();
    this.stopViewportWatch?.();
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

/**
 * Did anything the reader can see change?
 *
 * `tipsSeen` is bookkeeping, not a setting: dismissing the tips card would otherwise come back
 * through the settings relay as "Settings updated", which is both untrue and the last thing
 * someone wants to read immediately after closing a card.
 */
function changedVisibly(prev: Settings, next: Settings): boolean {
  return (Object.keys(next) as Array<keyof Settings>).some(
    (key) => key !== 'tipsSeen' && !sameValue(prev[key], next[key]),
  );
}

/** Settings are re-read from storage, so lists arrive as new arrays: compare them by content. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));
}

/** Settings that change what is *said* without changing the voice saying it. */
function changesSpokenText(prev: Settings, next: Settings): boolean {
  return (
    !sameValue(prev.pronunciations, next.pronunciations) ||
    prev.skipUrls !== next.skipUrls ||
    prev.expandAbbreviations !== next.expandAbbreviations
  );
}

/** Everything that decides which model the engine loads. Speed is applied per sentence, so not here. */
function engineIdentity(config: EngineConfig): string {
  const { speed: _speed, ...identity } = config;
  return JSON.stringify(identity);
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}
