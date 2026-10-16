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
import { buildTextIndex, changedEligibility, nearestBlock, rangeForSpan, visibleTextOf, type TextIndex } from '@/extract/text-index';
import { spokenToSource } from '@/highlight/word-map';
import { isSpeakable, normalizeForSpeech } from '@/segment/normalize';
import { applyPronunciations } from '@/segment/pronunciations';
import { GaplessScheduler } from '@/audio/scheduler';
import { Highlighter } from '@/highlight/highlighter';
import { CONTROL_HOST_ID, ControlBar, type BarVoice, type ExportState, type LanguageInfo } from '@/ui/control-bar';
import { voicePortrait } from '@/ui/voice-portraits';
import type { EngineConfig, WordTiming } from '@/engine/protocol';
import type { ModelManifest } from '@/engine/engines/types';
import { getSettings, setSettings, activeVoice, voiceKeyFor, type EngineId, type Settings, type VoiceRef } from '@/shared/settings';
import { ENGINE_IDS, engineInfo } from '@/shared/engine-catalog';
import { languageName, primaryLanguage, voiceLanguage, type CandidateVoice } from '@/shared/language-voice';
import { planLanguages, type Detection, type Detector, type PassageInput, type PassageLanguage } from './language-plan';
import { routeFor, voiceKey, type Route, type RouteContext } from './voice-routing';
import { MAX_LANES, VoiceLanes } from './voice-lanes';
import { listVoices, parseVoiceValue, voiceValue, type EngineVoice, type VoiceOption } from '@/shared/voice-catalog';
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
import { NOTES_FULL_MESSAGE, addNote } from '@/shared/notes';
import { createAnchor, type TextAnchor } from '@/annotate/anchor';
import { anchorForRange } from '@/annotate/page-anchoring';
import { recordListening } from '@/shared/reading-history';
import { countWords, recordCompleted, recordHeard, type Heard } from '@/shared/listening-stats';
import { log } from '@/shared/log';
import { capabilities } from '@/shared/browser-env';
import { GPU_GUIDE_URL } from '@/shared/links';

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
import { chunkWpm, speedLabel } from '@/shared/reading-rate';
import { READING_ATTR } from '@/annotate/palette';

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
   * Every status change, with the error when it is one. `begin` returns while the voice is still
   * loading, and a voice that then fails says so on the bar, not by throwing: a page that waits
   * for a voice to speak (the walkthrough's demo) follows this instead.
   */
  onStatus?: (status: SessionState['status'], error: string | undefined) => void;
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
/**
 * After this many sentences in a row fail to synthesise, stop and say so. Skipping a sentence that
 * fails is right; skipping *every* sentence is not — the page races past, highlighted and silent,
 * and looks like a reader that works.
 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** How much speech "back a little" replays. */
const BACK_A_LITTLE_SECONDS = 10;

/** How often heard audio is written to the statistics while reading (and at every pause). */
const STATS_WRITE_INTERVAL_MS = 30_000;

/** How far either side of the current sentence to look for one that exists in the DOM. */
const NEARBY_RANGE_SEARCH = 20;

export class ReaderSession {
  // ---- subsystems (built in begin()) --------------------------------------
  private settings!: Settings;
  private scheduler!: GaplessScheduler;
  /** Synthesis: the page's main voice, and the voices of its other languages beside it. */
  private worker!: VoiceLanes;
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
  /** Bumped by `dispose()`: anything still initialising from before it must stop where it is. */
  private generation = 0;
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
  /** Sentences in a row that failed to synthesise (see MAX_CONSECUTIVE_FAILURES). */
  private failures = 0;
  /**
   * Set when the voice stopped producing audio: nothing more is asked of the engine until play
   * is pressed or the voice changes, or it would keep failing the same way in the background.
   */
  private halted = false;
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
   * The document was read to the end and nothing has moved since. Play then means "again from
   * the top": the scheduler is parked past the last sentence, so without a seek it has nothing
   * to start and the button did nothing at all.
   */
  private finishedAtEnd = false;
  /**
   * A downloaded voice in the page's language, chosen for this page only (never saved), or null
   * when the saved voice is reading. See `matchVoiceToPage`.
   */
  private languageVoice: CandidateVoice | null = null;
  /** The language the page declares (`<html lang>`), as a hint for detection. */
  private declaredLanguage = '';
  /** The voice this page is locked to by the reader ("one voice for this page"), or null in Auto. */
  private manualVoice: CandidateVoice | null = null;
  /** Every downloaded voice, with its language. */
  private installedVoiceList: CandidateVoice[] = [];
  /** The detector's answers, by text — asked once per passage, however often the plan changes. */
  private readonly languageCache = new Map<string, Detection | null>();
  /** Each passage's language as planned, by passage number. */
  private passageLanguages: PassageLanguage[] = [];
  /** The reader's corrections ("this passage is in …"), by passage number. */
  private readonly correctedPassages = new Map<number, string>();
  /** Languages with no voice whose passages the reader chose to skip on this page. */
  private readonly skipLanguages = new Set<string>();
  /** Languages already reported as having no voice, so it is said once. */
  private readonly missingTold = new Set<string>();
  /** What the bar's language chip last showed, to update it only on a change. */
  private shownLanguageKey = '';
  /** Seconds of the sentence playing now already counted as heard (statistics). */
  private readonly heardCounted = new Map<number, number>();
  /**
   * Words of the page each sentence's audio was asked for with: what it says, not its words
   * hidden on the page — taken when it is asked for, since the page can change after.
   */
  private readonly madeWords = new Map<number, number>();
  /** Heard but not yet written to the statistics. */
  private heardQueue: Heard[] = [];
  private lastStatsWrite = 0;

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
    this.statusHook = opts.onStatus ?? null;
    this.sourceHint = opts.source ?? null;
    this.keepHistory = opts.keepHistory ?? true;
    // Snapshot the page selection *now*, before any await or DOM work can disturb it.
    if (mode === 'selection') this.selection = snapshotSelection();
    // "Read selection" / "Read from here" are explicit "start reading now" actions.
    this.wantsPlayback = mode === 'selection' || mode === 'from-cursor' || opts.autoplay === true;

    // Every await below is a chance for this session to be closed or replaced — a second tab
    // taking over, the reader closed while the manifest loads. Continuing after that built an
    // audio context, a worker and a bar that cleanup had already run past, and nothing would
    // take them down again.
    const generation = this.generation;
    const superseded = (): boolean => this.disposed || this.generation !== generation;

    this.settings = await getSettings();
    // Chunk sizes are fixed at planning time, before any engine exists, so start from what
    // synthesis did last time on this device rather than from an assumption about the browser.
    this.backend = (await loadLastBackend()) ?? 'cpu';
    this.manifest = await this.loadManifest();
    if (superseded()) return;
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
    if (superseded()) return;
    await this.matchVoiceToPage();
    if (superseded()) return;
    // The plan was built before the voice was settled: a German voice chosen for a German page
    // was given "Doctor Müller and Söhne", expanded for the English default.
    this.syncSpokenLanguage();
    this.showLanguage(this.currentPlayId);
    this.tapToSeek?.setEnabled(this.settings.tapToSeek);
    // Back from another tab — perhaps the one where the missing voice was just downloaded.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void this.refreshVoicesAvailable();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.stopVisibilityWatch = () => document.removeEventListener('visibilitychange', onVisible);
    await this.loadEngine();
  }

  private stopVisibilityWatch: (() => void) | null = null;

  private buildSubsystems(): void {
    this.scheduler = this.createScheduler();

    // A phone keeps one voice beside the main one, not two (voice-lanes.ts).
    this.worker = new VoiceLanes({
      onReady: ({ sampleRate, executionProvider }) => this.onEngineReady(executionProvider, sampleRate),
      onProgress: ({ progress }) => {
        this.state.modelProgress = progress;
        if (this.state.status === 'loading-model') this.pushState();
      },
      onAudio: (playId, pcm, sr, words) => {
        this.failures = 0;
        if (this.exporter) {
          this.exporter.accept(playId, pcm, sr);
          return;
        }
        if (sr > 0) {
          this.audioSeconds.set(playId, pcm.length / sr);
        }
        if (words?.length) this.wordTimings.set(playId, words);
        else this.wordTimings.delete(playId);
        this.scheduler.provide(playId, pcm, sr, leadSilenceSec(this.playlist[playId], this.settings));
      },
      onProvider: (executionProvider) => {
        // Where synthesis runs decides how far ahead the reader works and how much it buffers;
        // a GPU that gave out mid-article left both set for a machine that is no longer there.
        const backend = backendOf(executionProvider);
        if (backend === this.backend) return;
        log.info(`engine moved to ${executionProvider}: re-tuning for the ${backend}`);
        this.backend = backend;
        void saveLastBackend(backend);
        this.ensureSynth(this.currentPlayId);
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
        else if (this.halted) return;
        else if (playId != null && ++this.failures >= MAX_CONSECUTIVE_FAILURES && !this.exporter) void this.stopOnFailures(message);
        else if (playId != null) this.skipSentence(playId);
      },
      onLaneState: (voice, ready) => {
        if (!ready) this.bar?.flash(`Loading ${this.voiceLabel(voice.voice, voice.engine)} for the ${this.languageOfVoice(voice)} passages…`);
      },
      onLaneFailed: (voice, message, playIds) => {
        for (const id of playIds) this.requested.delete(id);
        const label = this.voiceLabel(voice.voice, voice.engine);
        this.bar?.flash(`${label} could not be loaded (${message}) — its passages are read by another voice`);
        void this.reroute();
      },
    }, { maxLanes: capabilities().formFactor === 'android' ? 2 : MAX_LANES });

    // Your saved highlights draw as underlines while the reader is open, so the one wash on the
    // page is the sentence being read (annotate/palette.ts: READING_ATTR).
    document.documentElement.setAttribute(READING_ATTR, '');
    this.bar = new ControlBar(document, this.controlCallbacks(), {
      speed: this.settings.speed,
      tapToSeek: this.settings.tapToSeek,
      theme: this.settings.theme,
      autoHide: this.settings.barAutoHide,
    });
    this.renderFollow();
    void this.refreshBarVoices();
    this.watchViewport();

    this.highlighter = new Highlighter(document, {
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
      wordStyle: this.settings.wordHighlight,
      keepReadable: this.settings.highlightReadable,
      bottomInset: () => this.bar?.coveredHeight() ?? 0,
    });

    this.media = new MediaControls(
      {
        play: () => void this.play(),
        pause: () => void this.pause(),
        previous: () => this.seekBy(-1),
        next: () => this.seekBy(1),
      },
      () => browser.runtime.sendMessage({ type: 'icon-data-url' }) as Promise<string | null>,
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
    this.maybeOfferGpuGuide(executionProvider);
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

  /** What the main voice was last loaded as (`engineIdentity`), to tell when it must change. */
  private loadedIdentity = '';

  /**
   * Kokoro or Supertonic on the processor is the one case where a setting elsewhere — the browser
   * keeping WebGPU from workers — costs real speed. Say so once, with the way to fix it; Piper is
   * fast anywhere and gets no tip, and someone who switched acceleration off chose that.
   */
  private maybeOfferGpuGuide(executionProvider: string): void {
    if (this.settings.gpuTipSeen || !this.settings.preferWebGPU || this.engine === 'piper') return;
    if (executionProvider.startsWith('webgpu')) return;
    void setSettings({ gpuTipSeen: true });
    this.bar?.flash(`${engineInfo(this.engine).name} is running on your processor — your graphics card would make it faster`, 'info', {
      label: 'How',
      run: () => window.open(GPU_GUIDE_URL, '_blank', 'noopener'),
    });
  }

  private async loadEngine(): Promise<void> {
    const reload = this.voiceReload;
    this.setStatus('loading-model');
    const config = this.engineConfig();
    this.loadedIdentity = engineIdentity(config);
    try {
      await this.worker.init(config);
    } catch (err) {
      // Closing the tab, pressing ✕ or starting another reader mid-load disposes the worker, which
      // rejects this init. That is the user's choice, not a failure — logging it as one only
      // buried the real errors.
      if (this.disposed) return;
      // Another voice was picked while this one loaded. Its load replaced this one — and is
      // under way now: "Failed to load the voice model" showed on the bar until it was ready.
      if (this.voiceReload !== reload) return;
      this.fail(`Failed to load the voice model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- extraction & planning ----------------------------------------------

  /**
   * Page text → spoken text. The reader's own pronunciation rules run first, on the text as
   * written, so "e.g." or "GPU" can be given a reading before the built-in expansions see them.
   */
  private normalize = (text: string): string => this.normalizeAs(text, (this.spokenLanguage = this.readingLanguage()));

  /** Page text → spoken text for a voice speaking `language`. */
  private normalizeAs(text: string, language: string): string {
    const fixed = applyPronunciations(text, this.settings.pronunciations);
    return normalizeForSpeech(fixed, {
      // Not "read URLs" as a replacement *string*: passing the sentence itself put the whole
       // sentence in place of every address it contained ("Visit Visit https://…  now. now.").
      urlReplacement: this.settings.skipUrls ? 'link' : null,
      expandAbbreviations: this.settings.expandAbbreviations,
      // The voice's language decides whether the English expansions apply at all.
      language,
    });
  }

  /**
   * Rebuild every sentence's spoken text after a change to how text is spoken, and re-synthesise
   * from the next sentence on — the same seam a speed change uses, so the sentence playing now
   * finishes as it was and the change is heard straight after it.
   */
  /** The language the spoken text was last prepared for (see `syncSpokenLanguage`). */
  private spokenLanguage: string | null = null;

  /** The language of the voice reading now, as the normaliser wants it. */
  private readingLanguage(): string {
    return (this.manifest && voiceLanguage(this.engine, this.voice, this.manifest)) || 'en';
  }

  /**
   * Prepare the spoken text again if the reading voice's language has changed since it was last
   * prepared — after a page-language voice is picked, or any voice change. The English expansions
   * apply to English voices only (segment/normalize.ts).
   */
  private syncSpokenLanguage(): void {
    this.routeItems(this.currentPlayId);
  }

  private respeak(): void {
    for (const item of this.playlist) {
      item.spokenAs = this.spokenLanguageOf(item);
      item.spokenText = this.normalizeAs(item.visibleSource ?? item.sourceText, item.spokenAs);
    }
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
      this.textIndex = buildTextIndex(selectionRoot(this.selection), { forReader: true });
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
      this.textIndex = buildTextIndex(liveRoot, { forReader: true });
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
    // Not on a sentence hidden on the page.
    if (this.playlist.length && !this.readable(this.playlist[this.currentPlayId])) {
      this.currentPlayId = this.readableNear(this.currentPlayId, 1);
      this.state.currentIndex = this.currentPlayId;
    }
    this.logPlan();
    this.refreshMediaMetadata();
    this.watchEligibility();
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
    const hidden = this.playlist.filter((p) => !p.eligible).length;
    log.info(
      `planned ${this.playlist.length} sentences; ${located} located in DOM` +
        (hidden > 0 ? `; ${hidden} hidden on the page` : '') +
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
      onOpenSettings: () => this.background()?.postMessage({ type: 'open-options' }),
      onOpenWalkthrough: () => this.background()?.postMessage({ type: 'open-walkthrough' }),
      onTipsDismissed: () => void setSettings({ tipsSeen: true }),
      onClose: () => this.stop('user'),
      onPassageLanguage: (code: string) => void this.setPassageLanguage(code),
      onVoiceLock: (locked: boolean) => void this.setVoiceLock(locked),
      onLanguageVoice: (code: string, value: string) => void this.setLanguageVoice(code, value),
      onMissingVoice: (code: string, choice: 'get' | 'skip' | 'read') => void this.onMissingVoice(code, choice),
      onFollow: () => void this.toggleFollow(),
      onManageVoices: () => this.background()?.postMessage({ type: 'open-options', view: 'voice' }),
      loadPortrait: (file: string) =>
        (browser.runtime.sendMessage({ type: 'voice-portrait', file }) as Promise<string | null>).catch(() => null),
    };
  }

  async play(): Promise<void> {
    this.halted = false;
    // Play after the end is a replay, from wherever `onFinished` left the index (the top).
    if (this.finishedAtEnd) {
      this.finishedAtEnd = false;
      this.requested.clear();
      this.worker.cancelFrom(this.currentPlayId, 0);
      this.scheduler.seek(this.currentPlayId);
      this.state.currentIndex = this.currentPlayId;
      this.highlighter?.show(this.playlist[this.currentPlayId]?.range ?? null);
    }
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
    // What was heard of the sentence playing, before the clock stops.
    this.countPartlyHeard();
    this.flushHeard();
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

  seekTo(playId: number, opts: { quiet?: boolean } = {}): void {
    if (this.exporter) {
      this.bar?.flash('Reading carries on once the MP3 is made', 'info');
      return;
    }
    // The part of the sentence heard before the jump counts; the rest was never heard.
    this.countPartlyHeard();
    const wanted = Math.max(0, Math.min(playId, this.playlist.length - 1));
    // Onto something that is read: forward for a move forward, back for a move back.
    const target = this.readableNear(wanted, wanted >= this.currentPlayId ? 1 : -1);
    // Moving anywhere means this is no longer "sitting at the end of the document".
    this.finishedAtEnd = false;
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
    this.showLanguage(target);
    if (!opts.quiet) this.bar?.flash(`Sentence ${target + 1} of ${this.playlist.length}`);
    this.refreshOffScreen();
  }

  /** The readable item nearest `from` in `direction`, then the other way; `from` itself if none is. */
  private readableNear(from: number, direction: 1 | -1): number {
    for (const dir of [direction, -direction as 1 | -1]) {
      for (let i = from; i >= 0 && i < this.playlist.length; i += dir) if (this.readable(this.playlist[i])) return i;
    }
    return from;
  }

  // ---- the page changing while it is read -------------------------------------

  private eligibilityObserver: MutationObserver | null = null;
  private eligibilityTimer = 0;

  /**
   * Follow the page while it is read. A translation revealed ahead is read when reached; one
   * hidden is passed over — and its audio, if already made, dropped. Revealing text behind the
   * playhead does not rewind: it is there for a seek or "read from here". The current sentence
   * hidden stops, and reading carries on at the next one.
   */
  private watchEligibility(): void {
    this.eligibilityObserver?.disconnect();
    if (!this.textIndex?.forReader || typeof MutationObserver === 'undefined') return;
    const root = this.textIndex.root;
    this.eligibilityObserver = new MutationObserver((records) => {
      // Only changes that can touch the text being read: inside it, or on something around it (a
      // class on <body>). A video's progress bar or a parallax header elsewhere says nothing.
      if (!records.some((r) => root.contains(r.target) || (r.target as Node).contains(root))) return;
      // A throttle, not a debounce: a page that animates without pause reset a debounce forever,
      // and a translation revealed meanwhile was never looked at.
      if (this.eligibilityTimer) return;
      this.eligibilityTimer = window.setTimeout(() => {
        this.eligibilityTimer = 0;
        // One after another: each run takes the page's changes since the last one, and works out
        // languages asynchronously — two at once could each miss what the other took.
        this.eligibilityRuns = this.eligibilityRuns
          .then(() => this.onEligibilityChanged())
          .catch((err) => log.warn('[eligibility] could not follow the page:', err));
      }, 200);
    });
    this.eligibilityObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden', 'inert'],
    });
  }

  private eligibilityRuns: Promise<void> = Promise.resolve();

  private async onEligibilityChanged(): Promise<void> {
    if (this.disposed || !this.textIndex) return;
    const ranges = changedEligibility(this.textIndex);
    if (!ranges.length) return;
    // What was heard of the sentence playing counts before anything about it changes.
    this.countPartlyHeard();
    const index = this.textIndex;
    const current = this.currentPlayId;
    const touches = (span: { start: number; end: number }): boolean => ranges.some(([a, b]) => span.start < b && a < span.end);
    const changed: number[] = [];
    let here = false;
    let hereReworded = false;
    // Only the sentences over what changed — a book-length page has thousands.
    for (const item of this.playlist) {
      if (!item.span || !touches(item.span)) continue;
      // Whole sentences shown or hidden, and words hidden inside a sentence still shown.
      const visible = visibleTextOf(index, item.span.start, item.span.end);
      const now = isSpeakable(visible);
      if (now === item.eligible && visible === item.visibleSource) continue;
      item.eligible = now;
      item.visibleSource = visible;
      if (now) item.spokenText = this.normalizeAs(visible, item.spokenAs ?? this.spokenLanguageOf(item));
      if (item.playId > current) changed.push(item.playId);
      else if (item.playId === current) {
        here = true;
        hereReworded = now;
      }
    }
    if (!changed.length && !here) return;
    log.info(`[eligibility] the page changed: ${this.playlist.filter((p) => p.eligible).length} of ${this.playlist.length} sentences readable`);

    // What shows decides a passage's language: English hidden and Italian revealed in its place is
    // an Italian passage now, for its own voice. Languages are worked out again (the detector
    // remembers every text it has seen, so only what is new is asked about), and a sentence whose
    // language or voice moved is made again like one whose words changed. A language the reader
    // corrected stays corrected (applyLanguages).
    const before = new Map(this.playlist.filter((i) => i.playId >= current).map((i) => [i.playId, routeSignature(i)]));
    await this.planPassageLanguages();
    if (this.disposed) return;
    this.routeItems(current);
    for (const [id, was] of before) {
      const item = this.playlist[id];
      if (!item || routeSignature(item) === was) continue;
      if (id > current) {
        if (!changed.includes(id)) changed.push(id);
      } else if (item.eligible) {
        here = true;
        hereReworded = true;
      }
    }
    this.languageVoice = this.pickPrimary();
    this.shownLanguageKey = '';
    this.showLanguage(current);
    // Moved on meanwhile: what was decided about "here" was about another sentence.
    if (this.currentPlayId !== current) {
      here = false;
      hereReworded = false;
    }

    if (this.exporter) {
      this.cancelExport('The page changed, so the MP3 was stopped');
      return;
    }
    if (!this.engineReady) return;
    if (here && !this.playlist[current]!.eligible) {
      // The sentence being read was hidden: on to the next one that is not, or the end — never back.
      this.moveOnFrom(current + 1);
      return;
    }
    // Words hidden in the sentence being read, or its language changed, before its audio started
    // (paused on it, or still buffering): its prepared audio says the old words, so it is made
    // again. Once it sounds, it finishes. Prepared but not yet scheduled, it is simply dropped;
    // already scheduled — paused before its first word — only a seek takes it back, which leaves
    // the pause as it is.
    if (hereReworded && !this.scheduler.started(current)) {
      if (this.scheduler.discard(current)) changed.unshift(current);
      else {
        this.seekTo(current, { quiet: true });
        return;
      }
    }
    this.remake(changed.sort((a, b) => a - b));
  }

  /**
   * Make again the upcoming sentences in `playIds`, and only those: a caption that changes fifty
   * sentences ahead does not cost the audio prepared for the forty-nine before it — on the CPU that
   * was the difference between reading on and running dry. A sentence already queued to play can
   * only be taken back by a seek, so from the first such one everything is made again.
   */
  private remake(playIds: number[]): void {
    for (const id of [...playIds].sort((a, b) => a - b)) {
      if (!this.scheduler.discard(id)) {
        // Already queued behind the sentence playing: re-plan everything after that sentence,
        // which keeps sounding (a seek would cut it off).
        this.requested.clear();
        this.worker.cancelFrom(this.currentPlayId + 1, 0);
        this.scheduler.reprimeForSpeed();
        break;
      }
      this.worker.drop(id);
      this.requested.delete(id);
      this.forgetAudio(id);
    }
    // The sentence being read is in `playIds` only when its audio has not started (see
    // onEligibilityChanged); then it is asked for again too.
    this.ensureSynth(playIds.includes(this.currentPlayId) ? this.currentPlayId : this.currentPlayId + 1);
    this.pushState();
  }

  /**
   * After the sentence being read was hidden or skipped: the next readable one, or — with none left
   * — the end of the document. Only forwards: what was already read is not read again.
   */
  private moveOnFrom(from: number): void {
    for (let i = Math.max(0, from); i < this.playlist.length; i++) {
      if (this.readable(this.playlist[i])) {
        this.seekTo(i, { quiet: true });
        return;
      }
    }
    void this.finishEarly();
  }

  /** Nothing readable is left after where reading is: stop as at the end of the page. */
  private async finishEarly(): Promise<void> {
    this.countPartlyHeard();
    this.stopFollowingWords(true);
    await this.scheduler.pause();
    this.onFinished();
  }


  /**
   * The pace of the chunk being heard — its words over its audio — set as each chunk starts and
   * held until the next, so the figure is steady (reading-rate.ts: chunkWpm). Never the pace of
   * the synthesis queue, and never a guess before any audio has played.
   */
  private showReadingRate(playId: number): void {
    if (this.disposed || this.exporter) return;
    const item = this.playlist[playId];
    const wpm = item ? chunkWpm(item.spokenText, this.audioSeconds.get(playId) ?? 0) : null;
    if (wpm != null) this.bar?.setReadingRate(wpm);
  }

  async setSpeed(speed: number): Promise<void> {
    this.settings = await setSettings({ speed });
    this.applySpeed(speed, { flash: true });
  }

  /**
   * One speed change, however it was asked for.
   *
   * The bar and the settings page used to do different things: the bar re-primed the scheduler,
   * the settings page only redrew the number — leaving sentences already synthesised at the old
   * speed to play on at it. Both now land here.
   */
  private applySpeed(speed: number, opts: { flash: boolean }): void {
    this.cancelExport('The speed changed, so the MP3 was stopped');
    this.bar?.setSpeed(speed);
    // The pace shown stays the current chunk's until a chunk made at the new speed starts.
    if (opts.flash) this.bar?.flash(`Speed ${speedLabel(speed)}`);
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
      steps: this.settings.supertonicSteps,
      preferWebGPU: this.settings.preferWebGPU,
      debug: this.settings.debug,
      speed: this.settings.speed,
      workers: this.settings.synthWorkers,
    };
  }

  private async loadManifest(): Promise<ModelManifest | null> {
    try {
      // From the background: models.json is not web-accessible (pages could use it to recognise
      // Aloud), and the reader runs in the page.
      const manifest = (await browser.runtime.sendMessage({ type: 'models-manifest' })) as ModelManifest | null;
      if (!manifest) throw new Error('the background had no models.json');
      return manifest;
    } catch (err) {
      log.warn('could not load models.json:', err);
      return null;
    }
  }

  /** Fill the control bar's voice picker for the active engine. */
  private async refreshBarVoices(): Promise<void> {
    if (!this.bar || !this.manifest) return;
    const manifest = this.manifest;
    // Every engine's downloaded voices: switching from Piper to a Kokoro voice is one pick.
    const perEngine = await Promise.all(
      ENGINE_IDS.map(async (engine) => (await this.installedVoices(engine)).map((v): EngineVoice => ({ ...v, engine }))),
    );
    // Read *after* the replies, never before: picking a second voice while the first was still
    // being answered painted the older choice back over the newer one on the picker.
    const route = this.playlist[this.currentPlayId]?.route;
    const current = route?.kind === 'voice' ? voiceValue(route.voice.engine, route.voice.id) : voiceValue(this.engine, this.voice);
    const shown = perEngine.flat();
    if (!shown.some((v) => voiceValue(v.engine, v.id) === current)) {
      const known = listVoices(this.engine, manifest).find((v) => v.id === this.voice);
      shown.unshift({ engine: this.engine, id: this.voice, label: `${known?.label ?? this.voice} · not downloaded yet`, group: known?.group ?? '' });
    }
    this.bar.setVoices(shown.map((v) => barVoice(v, manifest)), current);
  }

  /**
   * The voices of the active engine that are downloaded, asked of the background.
   *
   * The bar used to list all 171 Piper voices from the manifest, so switching voice mid-article
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
  /**
   * A voice picked on the bar: `engine:voice`, so it may be another engine's. What it changes
   * depends on what is being read, and the bar says which:
   *  - the page is locked to one voice: that voice, for this page;
   *  - a voice that does not speak the passage's language: the page is locked to it (Auto would
   *    otherwise switch straight back at the next passage);
   *  - a voice for a passage in another language than the saved voice's, or one with a voice
   *    already chosen: remembered as that language's voice, on every page;
   *  - otherwise: the saved voice, as before languages were told apart.
   */
  private async changeVoice(value: string): Promise<void> {
    const picked = parseVoiceValue(value, this.engine);
    if (!picked) return;
    const { engine, id: voice } = picked;
    const label = this.voiceLabel(voice, engine);
    const candidate: CandidateVoice = {
      engine,
      id: voice,
      label,
      language: this.manifest ? voiceLanguage(engine, voice, this.manifest) : '',
    };
    const item = this.playlist[this.currentPlayId];
    const language = item?.language ?? '';
    const reading = item?.route?.kind === 'voice' ? item.route.voice : this.savedVoice();
    if (voiceKey(reading) === voiceKey(candidate) && !this.manualVoice) return;
    const auto = this.settings.matchPageLanguage;
    const speaksIt = !language || primaryLanguage(candidate.language) === language;

    if (this.manualVoice) {
      this.manualVoice = candidate;
      this.bar?.flash(`Reading this whole page with ${label}`, 'ok');
    } else if (auto && !speaksIt) {
      this.manualVoice = candidate;
      this.bar?.flash(`Reading this whole page with ${label} — voices no longer follow the language here`, 'ok', {
        label: 'Undo',
        run: () => void this.setVoiceLock(false),
      });
    } else if (auto && (primaryLanguage(this.savedVoice().language) !== language || this.settings.languageVoices[language])) {
      this.settings = await setSettings({
        languageVoices: { ...this.settings.languageVoices, [language]: { engine, voice } },
      });
      this.bar?.flash(`${languageName(language)} is read by ${label} from now on`, 'ok');
    } else {
      this.settings = await setSettings({ engine, [voiceKeyFor(engine)]: voice });
      this.bar?.flash(engine === this.settings.engine ? `Switching to ${label}…` : `Switching to ${label} (${engineInfo(engine).name})…`);
    }
    this.failures = 0;
    this.halted = false;
    await this.reroute();
  }

  /** The human name of a voice id, falling back to the id itself. */
  private voiceLabel(voice: string, engine: EngineId = this.engine): string {
    if (!this.manifest) return voice;
    return listVoices(engine, this.manifest).find((v) => v.id === voice)?.label ?? voice;
  }

  /** Re-initialise the worker for a new engine/voice, keeping the plan and position. */
  async reloadEngine(): Promise<void> {
    // Every await below is a chance for this reader to be closed, replaced, or asked for another
    // voice. Without this, closing the reader while a voice change waited on the background built
    // a scheduler and a synthesis frame *after* disposal had run — nothing left to take them
    // down, and a model download started for a reader nobody could see. A second voice picked
    // while the first was still loading left the older one still working towards its engine.
    const generation = this.generation;
    const reload = ++this.voiceReload;
    const stale = (): boolean => this.disposed || this.generation !== generation || this.voiceReload !== reload;

    this.halted = false;
    this.failures = 0;
    this.settings = await getSettings();
    if (stale()) return;
    // A voice in another language reads the plan prepared for it, from the next sentence on.
    this.syncSpokenLanguage();
    this.cancelExport('The voice changed, so the MP3 was stopped');
    await this.refreshBarVoices();
    if (stale()) return;
    this.engineReady = false;
    this.requested.clear();
    this.state.modelProgress = 0;
    await this.scheduler.dispose();
    if (stale()) return;
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
      // Hidden text is not in the file, as it is not read (content/audio-export.ts: skip).
      // Each passage in the voice that reads it, as playback would.
      request: (id) =>
        this.readable(this.playlist[id])
          ? this.worker.request(id, this.playlist[id]!.spokenText, this.settings.speed, this.voiceFor(this.playlist[id]!))
          : exporter.skip(id),
      leadSilenceSec: (id) => (id === 0 ? 0 : leadSilenceSec(this.playlist[id], this.settings)),
      onProgress: (done, total) => {
        if (this.exporter === exporter) this.setExport({ phase: 'running', done, total });
      },
      onDone: (file, seconds, missing) => {
        if (this.exporter !== exporter) return;
        log.info(
          `mp3 export: ${this.playlist.length} sentences → ${seconds.toFixed(1)}s audio, ` +
            `${(file.size / 1e6).toFixed(2)} MB in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        );
        this.exportFile = file;
        this.endExport();
        this.setExport({ phase: 'done', seconds, bytes: file.size });
        // An export that lost sentences is still worth keeping, but saying "MP3 ready" alone
        // would hide that part of the page is silence.
        this.bar?.flash(
          missing.length === 0
            ? 'MP3 ready — press the save button to keep it'
            : `MP3 ready, but ${missing.length} sentence${missing.length === 1 ? '' : 's'} could not be spoken and ${
                missing.length === 1 ? 'is' : 'are'
              } silent`,
          missing.length === 0 ? 'ok' : 'info',
        );
        if (missing.length) log.warn(`mp3 export: ${missing.length} sentence(s) missing: ${missing.slice(0, 20).join(', ')}`);
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
   * Decide the language of every passage and the voice that reads it (content/language-plan.ts,
   * content/voice-routing.ts), and which voice is loaded first: the one reading most of the page.
   *
   * Replaces the per-page choice, which read a bilingual page entirely in one language. Nothing
   * here is saved: reading one French page never turns someone's voice French.
   */
  private async matchVoiceToPage(): Promise<void> {
    await this.loadInstalledVoices();
    await this.planPassageLanguages();
    this.routeItems(0);
    this.languageVoice = this.pickPrimary();
    this.reportLanguages();
  }

  /** Every downloaded voice of every engine, with the language it speaks. */
  private async loadInstalledVoices(): Promise<void> {
    const manifest = this.manifest;
    if (!manifest) {
      this.installedVoiceList = [];
      return;
    }
    this.installedVoiceList = (
      await Promise.all(
        ENGINE_IDS.map(async (engine) =>
          (await this.installedVoices(engine)).map(
            (v): CandidateVoice => ({ engine, id: v.id, label: v.label, language: voiceLanguage(engine, v.id, manifest) }),
          ),
        ),
      )
    ).flat();
  }

  /** The saved voice, as a candidate. */
  private savedVoice(): CandidateVoice {
    const engine = this.settings.engine;
    const id = activeVoice(this.settings);
    return { engine, id, label: this.voiceLabel(id, engine), language: this.manifest ? voiceLanguage(engine, id, this.manifest) : 'en' };
  }

  private routeContext(): RouteContext {
    return {
      auto: this.settings.matchPageLanguage,
      manual: this.manualVoice,
      saved: this.savedVoice(),
      preferences: this.settings.languageVoices,
      // A voice that failed to load on this page is not offered again.
      installed: this.installedVoiceList.filter((v) => !this.worker || this.worker.usable({ engine: v.engine, voice: v.id })),
      skip: this.skipLanguages,
      unvoiced: this.settings.unvoicedLanguages,
      removed: new Set(this.settings.removedLanguages),
      other: this.settings.otherVoice,
    };
  }

  /** The browser's language detector, in the shape the plan wants. */
  private detect: Detector = async (text) => {
    const result = await browser.i18n.detectLanguage(text);
    const top = result.languages?.[0];
    return top ? { language: top.language, reliable: Boolean(result.isReliable) } : null;
  };

  /** Group the plan into passages (blocks of the page) and decide each one's language. */
  private async planPassageLanguages(): Promise<void> {
    const index = this.textIndex;
    const passages: PassageInput[] = [];
    // What each passage shows, apart from all it holds: hidden words inside a shown passage (an
    // Italian aside kept `hidden`) would decide the language of the English around them. A passage
    // hidden entirely is judged by all its text, ready for when it is revealed.
    const shown: string[] = [];
    let prevBlock: Element | null = null;
    for (const item of this.playlist) {
      const node = item.range?.startContainer ?? null;
      const block = node && index ? nearestBlock(node, index.root) : null;
      if (passages.length === 0 || item.startsBlock || !block || block !== prevBlock) {
        passages.push({ text: '', markup: markupLanguage(node, index?.root ?? null) });
        shown.push('');
      }
      prevBlock = block;
      const at = passages.length - 1;
      const passage = passages[at]!;
      passage.text += (passage.text ? ' ' : '') + item.sourceText;
      if (item.eligible) shown[at] += (shown[at] ? ' ' : '') + (item.visibleSource ?? item.sourceText);
      item.passage = at;
    }
    passages.forEach((passage, i) => {
      if (/\p{L}/u.test(shown[i]!)) passage.text = shown[i]!;
    });
    let page = '';
    try {
      page = await this.detectPageLanguage();
    } catch {
      /* no detector: the page language stays unknown */
    }
    try {
      this.passageLanguages = await planLanguages(passages, this.detect, page, this.languageCache, this.declaredLanguage);
    } catch (err) {
      log.warn('could not plan languages:', err);
      this.passageLanguages = passages.map(() => ({ language: primaryLanguage(page), source: 'page' as const }));
    }
    this.applyLanguages();
  }

  /** Each item takes its passage's language, or the reader's correction of it. */
  private applyLanguages(): void {
    for (const item of this.playlist) {
      const passage = item.passage ?? -1;
      item.language = this.correctedPassages.get(passage) ?? this.passageLanguages[passage]?.language ?? '';
    }
  }

  /**
   * Route every item to its voice, and prepare its spoken text for that voice's language.
   * Reports whether the current item, or any after it, now sounds different.
   */
  private routeItems(from: number): { current: boolean; upcoming: boolean } {
    const ctx = this.routeContext();
    const changed = { current: false, upcoming: false };
    for (const item of this.playlist) {
      const before = item.route;
      item.route = routeFor(item.language ?? '', ctx);
      const language = this.spokenLanguageOf(item);
      let differs = !sameRoute(before, item.route);
      if (item.spokenAs !== language) {
        item.spokenText = this.normalizeAs(item.visibleSource ?? item.sourceText, language);
        item.spokenAs = language;
        differs = true;
      }
      if (!differs) continue;
      if (item.playId === from) changed.current = true;
      else if (item.playId > from) changed.upcoming = true;
    }
    return changed;
  }

  /** The language the voice reading `item` speaks — what its spoken text is prepared for. */
  private spokenLanguageOf(item: PlaylistItem): string {
    return item.route?.kind === 'voice' ? item.route.voice.language || 'en' : this.readingLanguage();
  }

  /** The voice to synthesise `item` with; undefined for the primary voice. */
  private voiceFor(item: PlaylistItem): VoiceRef | undefined {
    return item.route?.kind === 'voice' ? { engine: item.route.voice.engine, voice: item.route.voice.id } : undefined;
  }

  /** Spoken at all: shown on the page, and not in a language the reader chose to skip. */
  private readable(item: PlaylistItem | undefined): boolean {
    return !!item && item.eligible && item.route?.kind !== 'skip';
  }

  /** The voice reading the most of the page, when it is not the saved one. */
  private pickPrimary(): CandidateVoice | null {
    const weight = new Map<string, { voice: CandidateVoice; chars: number }>();
    for (const item of this.playlist) {
      if (!item.eligible || item.route?.kind !== 'voice') continue;
      const key = voiceKey(item.route.voice);
      const entry = weight.get(key) ?? { voice: item.route.voice, chars: 0 };
      entry.chars += item.sourceText.length;
      weight.set(key, entry);
    }
    let best: { voice: CandidateVoice; chars: number } | null = null;
    for (const entry of weight.values()) if (!best || entry.chars > best.chars) best = entry;
    if (!best || voiceKey(best.voice) === voiceKey(this.savedVoice())) return null;
    return best.voice;
  }

  /** One line on how the page will be read, when that is not simply "in your voice". */
  private reportLanguages(): void {
    const byLanguage = new Map<string, { chars: number; route: Route }>();
    for (const item of this.playlist) {
      if (!item.eligible || !item.route || !item.language) continue;
      const entry = byLanguage.get(item.language) ?? { chars: 0, route: item.route };
      entry.chars += item.sourceText.length;
      byLanguage.set(item.language, entry);
    }
    const summary = [...byLanguage].sort((a, b) => b[1].chars - a[1].chars);
    log.info(
      `[languages] ${summary
        .map(([lang, e]) => `${lang} ${e.chars} chars → ${e.route.kind === 'voice' ? `${e.route.voice.engine}/${e.route.voice.id} (${e.route.reason})` : 'skipped'}`)
        .join('; ')}`,
    );
    if (!this.settings.matchPageLanguage || this.manualVoice || summary.length === 0) return;
    const name = (lang: string): string => languageName(lang);
    const missing = summary.filter(([, e]) => e.route.kind === 'voice' && e.route.reason === 'missing').map(([l]) => l);
    if (summary.length === 1) {
      const [lang, { route }] = summary[0]!;
      if (route.kind !== 'voice') return;
      if (route.reason === 'match' || route.reason === 'preference') {
        if (voiceKey(route.voice) === voiceKey(this.savedVoice())) return;
        this.bar?.flash(`This page is in ${name(lang)} — reading it with ${shortLabel(route.voice.label)}`, 'ok');
      } else if (route.reason === 'missing') {
        this.missingTold.add(lang);
        this.bar?.flash(`This page is in ${name(lang)}, and no ${name(lang)} voice is downloaded — reading it in English`, 'info', {
          label: 'Get one',
          run: () => this.background()?.postMessage({ type: 'open-options', language: lang }),
        });
      }
      return;
    }
    const voices = summary
      .slice(0, 3)
      .filter(([, e]) => !(e.route.kind === 'voice' && e.route.reason === 'missing'))
      .map(([lang, e]) => (e.route.kind === 'voice' ? `${name(lang)} by ${shortLabel(e.route.voice.label)}` : `${name(lang)} skipped`));
    if (missing.length) {
      for (const lang of missing) this.missingTold.add(lang);
      const first = summary.find(([l]) => l === missing[0])?.[1].route;
      const reader = first?.kind === 'voice' ? shortLabel(first.voice.label) : shortLabel(this.savedVoice().label);
      this.bar?.flash(`No ${missing.map(name).join(' or ')} voice is downloaded, so ${reader} reads it in English`, 'info', {
        label: 'Choose',
        run: () => this.bar?.openLanguageMenu(),
      });
    } else {
      this.bar?.flash(`Reading ${voices.join(', ')}`, 'ok');
    }
  }

  /**
   * Show the language and voice of the passage at `playId` on the bar — and the first time a
   * passage with no voice of its own is reached, say so, once per language.
   */
  private showLanguage(playId: number): void {
    const item = this.playlist[playId];
    if (!item || !this.bar) return;
    const info = this.languageInfo(item);
    const key = JSON.stringify(info);
    if (key !== this.shownLanguageKey) {
      this.shownLanguageKey = key;
      this.bar.setLanguage(info);
      if (item.route?.kind === 'voice') this.bar.selectVoice(voiceValue(item.route.voice.engine, item.route.voice.id));
    }
    if (info.missing && !info.manual && info.auto && info.language && !this.missingTold.has(info.language)) {
      this.missingTold.add(info.language);
      this.bar.flash(`No ${info.name} voice is downloaded — ${info.voiceLabel} reads this ${info.name} passage in English`, 'info', {
        label: 'Choose',
        run: () => this.bar?.openLanguageMenu(),
      });
    }
  }

  private languageInfo(item: PlaylistItem): LanguageInfo {
    const language = item.language ?? '';
    const route = item.route;
    const voice = route?.kind === 'voice' ? route.voice : this.savedVoice();
    const corrected = this.correctedPassages.has(item.passage ?? -1);
    const source = corrected ? 'corrected' : (this.passageLanguages[item.passage ?? -1]?.source ?? 'page');
    const how: Record<string, string> = {
      corrected: 'as you set it',
      markup: 'marked by the page',
      detected: 'detected',
      script: 'from its script',
      context: 'from the passages around it',
      page: 'the page’s language',
    };
    const codes = new Set<string>();
    for (const p of this.playlist) if (p.language) codes.add(p.language);
    for (const v of this.installedVoiceList) if (primaryLanguage(v.language)) codes.add(primaryLanguage(v.language));
    const speaking = this.installedVoiceList.filter((v) => primaryLanguage(v.language) === language);
    const preferred = this.settings.languageVoices[language];
    return {
      language,
      name: language ? languageName(language) : '',
      how: how[source] ?? 'detected',
      voiceLabel: shortLabel(voice.label),
      missing: route?.kind === 'skip' || (route?.kind === 'voice' && route.reason === 'missing'),
      skipped: route?.kind === 'skip',
      manual: !!this.manualVoice,
      auto: this.settings.matchPageLanguage,
      languages: [...codes].map((code) => ({ code, name: languageName(code) })).sort((a, b) => a.name.localeCompare(b.name)),
      voices: speaking.map((v) => ({ value: voiceValue(v.engine, v.id), label: v.label })),
      preferred: preferred ? voiceValue(preferred.engine, preferred.voice) : '',
    };
  }

  /** "Italian", for a lane's voice. */
  private languageOfVoice(voice: VoiceRef): string {
    const tag = this.manifest ? voiceLanguage(voice.engine, voice.voice, this.manifest) : '';
    return tag ? languageName(primaryLanguage(tag)) : 'other';
  }

  /**
   * The voices changed — a correction, a lock, a remembered voice, one that failed to load.
   * Apply it without losing the place: a new main voice reloads (keeping the position, as a voice
   * change always has); otherwise only the sentences that now sound different are made again.
   */
  private async reroute(): Promise<void> {
    if (this.disposed || this.playlist.length === 0) return;
    // Heard is heard: counted before the voice or the plan around it changes.
    this.countPartlyHeard();
    const current = this.currentPlayId;
    const changed = this.routeItems(current);
    this.languageVoice = this.pickPrimary();
    this.shownLanguageKey = '';
    this.showLanguage(current);
    this.refreshMediaMetadata();
    // Not until the first load: then the voice is simply loaded as planned.
    if (this.loadedIdentity && engineIdentity(this.engineConfig()) !== this.loadedIdentity) {
      this.pendingVoiceLabel = this.voiceLabel(this.voice);
      await this.reloadEngine();
      return;
    }
    if (!changed.current && !changed.upcoming) return;
    this.cancelExport('The voices changed, so the MP3 was stopped');
    if (!this.engineReady) return;
    if (changed.current) {
      // The sentence playing now sounds different, or is now skipped: say it again, or move on.
      if (this.readable(this.playlist[current])) this.seekTo(current, { quiet: true });
      else this.moveOnFrom(current + 1);
      return;
    }
    this.resynthesizeUpcoming();
  }

  /** Everything after the sentence playing is made again; the sentence playing finishes as it was. */
  private resynthesizeUpcoming(): void {
    const keepFrom = this.currentPlayId + 1;
    this.requested.clear();
    this.worker.cancelFrom(keepFrom, 0);
    this.scheduler.reprimeForSpeed();
    this.ensureSynth(keepFrom);
    this.pushState();
  }

  /** "This passage is in …": the reader's correction, for this page. */
  private async setPassageLanguage(code: string): Promise<void> {
    const item = this.playlist[this.currentPlayId];
    if (!item || item.passage == null || !code) return;
    this.correctedPassages.set(item.passage, primaryLanguage(code));
    this.applyLanguages();
    this.bar?.flash(`Reading this passage as ${languageName(code)}`, 'ok');
    await this.reroute();
  }

  /** Lock this page to the voice reading now, or let voices follow the language again. */
  private async setVoiceLock(locked: boolean): Promise<void> {
    if (locked) {
      const item = this.playlist[this.currentPlayId];
      this.manualVoice = item?.route?.kind === 'voice' ? item.route.voice : this.savedVoice();
      this.bar?.flash(`Reading this whole page with ${shortLabel(this.manualVoice.label)}`, 'ok', {
        label: 'Undo',
        run: () => void this.setVoiceLock(false),
      });
    } else {
      this.manualVoice = null;
      this.bar?.flash('Voices follow the language again', 'ok');
    }
    await this.reroute();
  }

  /** Remember `value` as the voice for `code`, on every page. */
  private async setLanguageVoice(code: string, value: string): Promise<void> {
    const picked = parseVoiceValue(value, this.engine);
    if (!picked || !code) return;
    this.settings = await setSettings({
      languageVoices: { ...this.settings.languageVoices, [code]: { engine: picked.engine, voice: picked.id } },
    });
    this.bar?.flash(`${languageName(code)} is read by ${this.voiceLabel(picked.id, picked.engine)} from now on`, 'ok');
    await this.reroute();
  }

  /** A language with no voice: get one, skip its passages, or read them with the usual voice. */
  private async onMissingVoice(code: string, choice: 'get' | 'skip' | 'read'): Promise<void> {
    if (choice === 'get') {
      this.background()?.postMessage({ type: 'open-options', language: code });
      return;
    }
    if (choice === 'skip') this.skipLanguages.add(code);
    else this.skipLanguages.delete(code);
    this.bar?.flash(
      choice === 'skip' ? `Skipping ${languageName(code)} passages on this page` : `Reading ${languageName(code)} passages again`,
      'ok',
    );
    await this.reroute();
    // Skipping the passage playing now: on to the next one that is read.
    if (choice === 'skip' && !this.readable(this.playlist[this.currentPlayId]) && this.engineReady) {
      this.moveOnFrom(this.currentPlayId + 1);
    }
  }

  /**
   * A voice may have been downloaded in another tab (the "Get one" button): look again when the
   * reader comes back to this one, and use it from the next sentence.
   */
  private async refreshVoicesAvailable(): Promise<void> {
    if (this.disposed || this.playlist.length === 0 || !this.manifest) return;
    const before = this.installedVoiceList.map(voiceKey).sort().join();
    await this.loadInstalledVoices();
    if (this.installedVoiceList.map(voiceKey).sort().join() === before) return;
    void this.refreshBarVoices();
    await this.reroute();
  }

  /**
   * The page's language: the browser's own detector when it is sure, else the page's declared
   * language when the detector does not contradict it. `<html lang>` alone is not trusted — CMS
   * templates ship `lang="en"` on pages in every language.
   */
  private async detectPageLanguage(): Promise<string> {
    // What is read, not what is on the page: a hidden translation is another language entirely.
    const sample = this.playlist
      .filter((p) => p.eligible)
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
    if (!this.engineReady || this.exporter || this.halted) return;
    const end = Math.min(fromPlayId + this.tuning.lookahead + 1, this.playlist.length);
    for (let i = fromPlayId; i < end; i++) {
      if (this.requested.has(i)) continue;
      const item = this.playlist[i];
      if (!item) continue;
      this.requested.add(i);
      // Hidden on the page now (a collapsed translation), or in a language the reader skips:
      // passed over in silence, with no pause.
      if (!this.readable(item)) {
        // Nothing of it is heard: forget the length of audio made for it before it was hidden,
        // which `onChunkEnd` would otherwise count when this silence ends.
        this.forgetAudio(i);
        this.scheduler.provide(i, new Float32Array(0), this.sampleRate, 0);
        continue;
      }
      this.madeWords.set(i, countWords(item.visibleSource ?? item.sourceText, item.language));
      this.worker.request(i, item.spokenText, this.settings.speed, this.voiceFor(item));
    }
  }

  private onChunkStart(playId: number): void {
    // A new play of this sentence: nothing of it heard yet (a replay is heard again).
    this.heardCounted.set(playId, 0);
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

    // A sentence passed over (hidden on the page, or skipped): nothing to show or count.
    if (this.playlist[playId] && !this.readable(this.playlist[playId])) {
      this.ensureSynth(playId + 1);
      return;
    }
    this.showLanguage(playId);

    if (this.settings.highlight) {
      // Never blank the highlight while audio is playing: fall back to the enclosing block, then
      // to whatever was last shown, so the reader's eye is never left stranded.
      const item = this.playlist[playId];
      const range = item?.range ?? item?.blockRange ?? this.lastShownRange;
      if (range) this.lastShownRange = range;
      this.highlighter?.show(range);
    }

    this.prepareWords(playId);
    this.showReadingRate(playId);
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
    if (!this.settings.highlight || this.settings.wordHighlight === 'off' || !this.highlighter?.canShowWords) return;
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
  /**
   * The voice is not producing audio at all: stop, keep the place, and say what to do. Picking
   * another voice on the bar (or pressing play to try again) carries on from here.
   */
  private async stopOnFailures(message: string): Promise<void> {
    const reason = message.split('\n')[0]!.replace(/^\[[^\]]*\]\s*/, '').slice(0, 140);
    log.error(`${this.failures} sentences in a row failed — stopping instead of skipping on:`, reason);
    this.failures = 0;
    this.halted = true;
    this.requested.clear();
    this.worker.cancelFrom(this.currentPlayId, 0);
    this.scheduler.seek(this.currentPlayId);
    await this.pause();
    // The status line keeps saying it until play is pressed; the flash offers the way out. The
    // first-run tips card would hide both, and matters less than a voice that says nothing.
    this.bar?.hideTips();
    this.state.hint = `${this.voiceLabel(this.voice)} produced no audio — pick another voice`;
    this.pushState();
    this.bar?.flash(`${this.voiceLabel(this.voice)} is not producing any audio — pick another voice, or press play to retry`, 'info', {
      label: 'Settings',
      run: () => this.background()?.postMessage({ type: 'open-options' }),
    });
  }

  private skipSentence(playId: number): void {
    log.warn(`sentence ${playId} could not be synthesised — skipping it`);
    // Left in `requested` on purpose: removing it made the very next top-up ask for the same
    // sentence again, which failed the same way — two or three doomed requests per sentence.
    // A seek clears `requested`, so jumping back to it still gives it a fresh try.
    if (this.exporter) this.exporter.accept(playId, new Float32Array(0), this.sampleRate);
    else {
      this.forgetAudio(playId);
      this.scheduler.provide(playId, new Float32Array(0), this.sampleRate, 0);
    }
  }

  /** What was known of audio made for `playId` that will not be heard. */
  private forgetAudio(playId: number): void {
    this.audioSeconds.delete(playId);
    this.wordTimings.delete(playId);
    this.madeWords.delete(playId);
  }

  private onChunkEnd(playId: number): void {
    this.countHeard(playId, Infinity);
    if (Date.now() - this.lastStatsWrite > STATS_WRITE_INTERVAL_MS) this.flushHeard();
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
    this.finishedAtEnd = true;
    this.stopFollowingWords(true);
    this.wantsPlayback = false;
    this.state.busy = false;
    this.highlighter?.clear();
    this.currentPlayId = 0;
    this.state.currentIndex = this.playlist.length;
    this.setStatus('paused');
    this.bar?.flash('Finished reading this page', 'ok');
    this.currentOffScreen = false;
    this.renderFollow();
    // Read to the end: next time it opens at the top, not at the last sentence.
    this.lastSavedIndex = -1;
    if (this.docKey) void clearPosition(this.docKey);
    this.recordHistory(this.playlist.length, true);
    this.flushHeard();
    if (this.keepHistory && this.docKey && this.mode !== 'selection') void recordCompleted(this.docKey);
    this.finishedHook?.();
  }

  // ---- statistics ----------------------------------------------------------

  /**
   * Count `playId` as heard up to `upTo` seconds into its speech (Infinity: to its end), less what
   * was already counted of this play of it. Only audio that played: a sentence passed over, or
   * one that never arrived, has no length and adds nothing; "Save as MP3" never plays here.
   */
  private countHeard(playId: number, upTo: number): void {
    if (!this.keepHistory) return;
    const item = this.playlist[playId];
    const total = this.audioSeconds.get(playId) ?? 0;
    // Audio that played counts, whatever has happened to the sentence since — hidden, rerouted or
    // skipped a moment later, it was still heard. A sentence passed over has no audio at all.
    if (!item || total <= 0) return;
    const already = this.heardCounted.get(playId) ?? 0;
    const to = Math.min(total, Math.max(0, upTo));
    if (to <= already) return;
    this.heardCounted.set(playId, to);
    const share = (to - already) / total;
    this.heardQueue.push({
      at: Date.now(),
      seconds: to - already,
      words: (this.madeWords.get(playId) ?? countWords(item.visibleSource ?? item.sourceText, item.language)) * share,
      site: this.docSource().site ?? '',
      language: item.language ?? '',
    });
  }

  /** The sentence playing now, as far as it has been heard. */
  private countPartlyHeard(): void {
    const at = this.scheduler?.isPlaying() ? this.scheduler.playbackPosition() : null;
    if (at) this.countHeard(at.playId, at.seconds);
  }

  private flushHeard(): void {
    this.lastStatsWrite = Date.now();
    if (!this.heardQueue.length) return;
    const heard = this.heardQueue;
    this.heardQueue = [];
    void recordHeard(heard);
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
      const { duplicate, full } = await addNote({
        text,
        source: this.docSource(),
        at: { index, total: this.playlist.length, excerpt: excerptOf(this.playlist[index]?.spokenText ?? '') },
        ...(onWebPage && anchor
          ? { anchor, color: this.settings.annotate.defaultColor, style: this.settings.annotate.defaultStyle, tags: [] }
          : {}),
      });
      if (full) {
        this.bar?.flash(NOTES_FULL_MESSAGE);
        return;
      }
      this.bar?.flash(duplicate ? 'Already in your notes' : 'Saved to Notes', 'ok', {
        label: 'Open',
        run: () => this.background()?.postMessage({ type: 'open-library', tab: 'notes' }),
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

    // Which voice reads which passage: Auto, the voices chosen per language, the saved voice, and
    // the Voice page's last row — who reads every other language, whether those are skipped, and
    // which languages were taken off the board. Missing those three, a choice made there was saved
    // but an open reader kept its old voices until it was started again.
    const next = this.settings;
    if (
      prev.matchPageLanguage !== next.matchPageLanguage ||
      !sameValue(prev.languageVoices, next.languageVoices) ||
      !sameValue(prev.otherVoice, next.otherVoice) ||
      prev.unvoicedLanguages !== next.unvoicedLanguages ||
      !sameValue(prev.removedLanguages, next.removedLanguages) ||
      prev.engine !== next.engine ||
      activeVoice(prev) !== activeVoice(next)
    ) {
      const changed = this.routeItems(this.currentPlayId);
      this.languageVoice = this.pickPrimary();
      this.shownLanguageKey = '';
      this.showLanguage(this.currentPlayId);
      // A new main voice reloads below; otherwise only what now sounds different is made again.
      if (engineIdentity(this.engineConfig()) === prevEngine && (changed.current || changed.upcoming)) {
        this.cancelExport('The voices changed, so the MP3 was stopped');
        if (this.engineReady) {
          if (changed.current) this.seekTo(this.currentPlayId, { quiet: true });
          else this.resynthesizeUpcoming();
        }
      }
    }

    this.highlighter?.setOptions({
      color: this.settings.highlightColor,
      scrollMode: this.settings.scrollMode,
      wordStyle: this.settings.wordHighlight,
      keepReadable: this.settings.highlightReadable,
    });
    if (!this.settings.highlight || this.settings.wordHighlight === 'off') this.stopFollowingWords(true);
    else if (prev.wordHighlight === 'off' && this.scheduler?.isPlaying()) this.prepareWords(this.currentPlayId);
    if (prev.tapToSeek !== this.settings.tapToSeek) {
      this.tapToSeek?.setEnabled(this.settings.tapToSeek);
      this.bar?.setTapToSeek(this.settings.tapToSeek);
    }
    // A speed set in the settings page means the same thing as one set on the bar.
    if (prev.speed !== this.settings.speed) this.applySpeed(this.settings.speed, { flash: false });
    if (prev.theme !== this.settings.theme) this.bar?.setTheme(this.settings.theme);
    if (prev.barAutoHide !== this.settings.barAutoHide) this.bar?.setAutoHide(this.settings.barAutoHide);
    if (prev.scrollMode !== this.settings.scrollMode) this.renderFollow();

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
    // The reader's own hand on the page — not Aloud following the sentence, and not the bar.
    const intent = (e: Event): void => {
      if ((e.target as Element | null)?.id === CONTROL_HOST_ID) return;
      if (e.type === 'keydown' && !/^(ArrowDown|ArrowUp|PageDown|PageUp|Home|End| )$/.test((e as KeyboardEvent).key)) return;
      this.userScrollIntent = Date.now();
    };
    const intents = ['wheel', 'touchmove', 'keydown'] as const;
    view.addEventListener('scroll', onChange, { passive: true, capture: true });
    view.addEventListener('resize', onChange, { passive: true });
    for (const type of intents) view.addEventListener(type, intent, { passive: true, capture: true });
    this.stopViewportWatch = () => {
      if (this.offScreenFrame) view.cancelAnimationFrame(this.offScreenFrame);
      view.removeEventListener('scroll', onChange, { capture: true });
      view.removeEventListener('resize', onChange);
      for (const type of intents) view.removeEventListener(type, intent, { capture: true });
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
    const following = this.settings.scrollMode !== 'off';
    // Your own scrolling took the sentence off screen: you are looking at something else, and
    // following rests rather than pull you back at the next sentence. Scroll back to it — or
    // press Follow — and it carries on.
    if (following && offScreen && !this.followPaused && Date.now() - this.userScrollIntent < 1500) this.setFollowPaused(true);
    else if (this.followPaused && !offScreen) this.setFollowPaused(false);
    if (offScreen === this.currentOffScreen && !this.followDirty) return;
    this.currentOffScreen = offScreen;
    this.renderFollow();
  }

  // ---- following the reading ----------------------------------------------

  /** Following rests while the reader looks elsewhere on the page. */
  private followPaused = false;
  /** When the reader last scrolled the page themselves (wheel, touch, keys) — not Aloud. */
  private userScrollIntent = 0;
  private followDirty = false;

  private setFollowPaused(paused: boolean): void {
    if (paused === this.followPaused) return;
    this.followPaused = paused;
    this.highlighter?.setFollowPaused(paused);
    this.followDirty = true;
    this.renderFollow();
  }

  private renderFollow(): void {
    this.followDirty = false;
    const state = this.settings.scrollMode === 'off' ? 'off' : this.followPaused ? 'away' : 'on';
    this.bar?.setFollow(state, this.currentOffScreen);
  }

  /**
   * The bar's Follow button. Following and in sight: stop following. Resting, off, or the sentence
   * out of sight: go back to it and follow from there. The choice is kept, like the setting.
   */
  private async toggleFollow(): Promise<void> {
    const mode = this.settings.scrollMode;
    if (mode !== 'off' && !this.followPaused && !this.currentOffScreen) {
      this.settings = await setSettings({ scrollMode: 'off' });
      this.highlighter?.setOptions({ scrollMode: 'off' });
      this.renderFollow();
      this.bar?.flash('Not following the reading — the page stays where you put it', 'ok');
      return;
    }
    if (mode === 'off') {
      this.settings = await setSettings({ scrollMode: 'keep-visible' });
      this.highlighter?.setOptions({ scrollMode: 'keep-visible' });
    }
    this.setFollowPaused(false);
    this.snapToCurrent();
    this.renderFollow();
    if (mode === 'off') this.bar?.flash('Following the reading', 'ok');
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

  private connectPort(resume = false): void {
    try {
      this.port = browser.runtime.connect({ name: resume ? `${PORT_NAME}:resume` : PORT_NAME });
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
      this.port.onDisconnect.addListener(() => {
        // Chromium stops an idle background service worker, and with it this connection. It is
        // made again when this reader next needs the background (`background()`): reconnecting
        // at once woke the worker again, and it was stopped and woken every thirty seconds for
        // as long as a reader stayed open. Left dropped for good, the reader was invisible to the
        // background: a reader started in another tab no longer stopped this one.
        this.port = null;
      });
    } catch (err) {
      // "Extension context invalidated": Aloud was updated or reloaded under this page.
      log.warn('could not connect to background:', err);
    }
  }

  /**
   * The connection to the background, made again if Chromium stopped it while this reader sat
   * idle. `claim` when the listener has just used this reader (pressed play, or a button that
   * asks for a page): it becomes the one reading, and any other stops. Otherwise — a reader that
   * was already playing, reconnecting to report its progress — it is a resume, and yields to a
   * reader started meanwhile (background.ts). Settings changed while it was down are picked up.
   */
  private background(claim = true): Browser.runtime.Port | null {
    if (this.port || this.disposed) return this.port;
    this.connectPort(!claim);
    if (this.port) void this.onSettingsChanged();
    return this.port;
  }

  private statusHook: BeginOptions['onStatus'] | null = null;
  /** Counts voice reloads, so an older one stops as soon as another is asked for. */
  private voiceReload = 0;
  /** Whether the last state pushed was one of reading (see `pushState`). */
  private wasActive = false;

  private setStatus(status: SessionState['status']): void {
    this.state.status = status;
    try {
      this.statusHook?.(status, status === 'error' ? this.state.error : undefined);
    } catch (err) {
      log.warn('status hook failed:', err);
    }
    this.pushState();
  }

  private pushState(): void {
    if (this.disposed) return;
    this.bar?.update(this.state);
    this.media?.setPlaying(this.state.status === 'playing' ? 'playing' : 'paused');
    try {
      // An idle reader leaves the background asleep; one that reads (or is getting ready to)
      // needs it, for the toolbar badge and to stop any other reader.
      const active = ['playing', 'extracting', 'loading-model'].includes(this.state.status);
      const started = active && !this.wasActive;
      this.wasActive = active;
      (active ? this.background(started) : this.port)?.postMessage({ type: 'state', state: this.state });
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
    this.countPartlyHeard();
    this.flushHeard();
    this.disposed = true;
    // Anything still working through `begin()` stops at its next checkpoint.
    this.generation++;

    this.eligibilityObserver?.disconnect();
    this.eligibilityObserver = null;
    clearTimeout(this.eligibilityTimer);
    this.stopFollowingWords(false);
    this.tapToSeek?.dispose();
    this.sleepTimer?.dispose();
    this.exporter?.cancel();
    this.exporter = null;
    this.media?.dispose();
    this.stopViewportWatch?.();
    this.stopVisibilityWatch?.();
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
    document.documentElement.removeAttribute(READING_ATTR);

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
/** What a sentence is said as: its language, its voice (or skipped), and the text prepared for it. */
function routeSignature(item: PlaylistItem): string {
  const route = item.route;
  const voice = route?.kind === 'voice' ? `${route.voice.engine}:${route.voice.id}` : route?.kind ?? '';
  return `${item.language ?? ''}|${voice}|${item.spokenAs ?? ''}|${item.spokenText}`;
}

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

/** The same voice, or both skipped, or both unset. */
function sameRoute(a: Route | undefined, b: Route | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'skip' || b.kind === 'skip') return a.kind === b.kind;
  return voiceKey(a.voice) === voiceKey(b.voice);
}

/**
 * The language a passage is marked with by the page itself: the nearest `lang` attribute, unless
 * it is page-wide — on `<html>`, `<body>`, or anything wrapping the whole text being read, which
 * is where CMS templates put a language that is often wrong.
 */
function markupLanguage(node: Node | null, root: Element | null): string {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const tagged = el?.closest('[lang]');
  if (!tagged || tagged === document.documentElement || tagged === document.body) return '';
  if (root && tagged.contains(root)) return '';
  return tagged.getAttribute('lang') ?? '';
}

/** A voice as the bar's menu shows it: a name, a line about it, a face. */
function barVoice(v: EngineVoice, manifest: ModelManifest): BarVoice {
  const [name, ...rest] = v.label.split(' · ');
  const tag = voiceLanguage(v.engine, v.id, manifest);
  const region = tag.replace('_', '-');
  let language = region;
  try {
    language = new Intl.DisplayNames(['en'], { type: 'language' }).of(region) ?? region;
  } catch {
    /* an unusual tag: shown as it is */
  }
  return {
    value: voiceValue(v.engine, v.id),
    name: name ?? v.id,
    meta: [engineInfo(v.engine).name, language, ...rest].filter(Boolean).join(' · '),
    language: primaryLanguage(tag),
    portrait: voicePortrait(v.engine, v.id)?.file ?? null,
  };
}

/** "Alba · medium" → "Alba": the name, for messages. */
function shortLabel(label: string): string {
  return label.split(' · ')[0] ?? label;
}
