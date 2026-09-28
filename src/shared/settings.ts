/**
 * User settings, persisted in `browser.storage.local`.
 *
 * `storage.local` (not `sync`) because voice/engine choices are device-specific and we never
 * want to accidentally sync large values. Model *files* live in IndexedDB, not here.
 */
import { storage } from 'wxt/utils/storage';
import type { PronunciationRule } from '@/segment/pronunciations';
import { withStorageLock } from './storage-lock';

export type EngineId = 'piper' | 'kokoro' | 'supertonic';

/** How the page scrolls to follow the sentence being read. */
/** How the word being spoken is marked (see `Settings.wordHighlight`). */
export type WordHighlightStyle = 'darker' | 'underline' | 'off';

export type ScrollMode = 'off' | 'keep-visible' | 'snap';

/**
 * How a PDF is presented in Aloud's reader page.
 *
 * `pages` draws the real pages and highlights the sentence on the page itself, so the document
 * still looks like the document — figures, tables, columns and all. `reflow` rebuilds it as
 * ordinary article HTML, which is the readable option on a phone and the only one that gets
 * dark mode and resizable text, at the cost of the original appearance.
 */
export type PdfView = 'pages' | 'reflow';

/**
 * Which colour theme Aloud paints itself in.
 *
 * `system` follows the OS/browser preference and keeps following it while a page is open;
 * `light` and `dark` are explicit and override it everywhere Aloud draws its own UI — the
 * in-page control bar, the options page, the PDF reader and the walkthrough.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** Parts of an article to pass over when reading a whole page (see content/skip-rules.ts). */
export interface SkipSettings {
  /** Code listings (`<pre>`). Inline `<code>` inside a sentence is always read. */
  code: boolean;
  /** Everything inside a `<table>`. */
  tables: boolean;
  /** Figure and table captions. */
  captions: boolean;
  /** The references / notes / further-reading section at the end, and footnote lists. */
  references: boolean;
}

/**
 * Code is skipped by default (a listing read symbol by symbol helps nobody) and so is the
 * reference list; tables and captions are read, because they are often part of the argument.
 */
export const DEFAULT_SKIP: SkipSettings = { code: true, tables: false, captions: false, references: true };

/**
 * The media speed control: Aloud's second job, setting the playback rate of any `<video>` or
 * `<audio>` on a page from the keyboard.
 *
 * Off-page by default in the sense that matters: Aloud declares no content script for all sites,
 * so the control is injected into a tab by its own shortcut, or — for sites listed in
 * `alwaysOn` — by a script registered only after you grant that site.
 */
export interface MediaSpeedSettings {
  /** The whole feature, including the shortcut. */
  enabled: boolean;
  /** How much one press of faster / slower moves the rate. */
  step: number;
  /** The rates the preset keys cycle through, and the buttons offer. */
  presets: number[];
  /** The rate the "preferred speed" key toggles to, and back from. */
  preferred: number;
  /** Start every video at this rate (0 = whatever the site set). */
  startAt: number;
  /** Remember the rate per site, and use it next time you are there. */
  rememberPerSite: boolean;
  /** Show the speed briefly over the video when it changes. */
  showBadge: boolean;
  /** Hosts the control starts on by itself, once that site's permission has been granted. */
  alwaysOn: string[];
  /** Key bindings, as text — see media-speed/keys.ts. */
  keys: {
    faster: string;
    slower: string;
    reset: string;
    preferred: string;
    nextPreset: string;
    previousPreset: string;
  };
}

/**
 * Defaults chosen to sit beside a video site's own shortcuts rather than on top of them: D and S
 * are free on YouTube, Netflix and the BBC, and the rest are deliberately unbound until someone
 * asks for them.
 */
export const DEFAULT_MEDIA_SPEED: MediaSpeedSettings = {
  enabled: true,
  step: 0.1,
  presets: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4],
  preferred: 1.75,
  startAt: 0,
  rememberPerSite: true,
  showBadge: true,
  alwaysOn: [],
  keys: {
    faster: 'd',
    slower: 's',
    reset: 'r',
    preferred: 'g',
    nextPreset: 'shift+d',
    previousPreset: 'shift+s',
  },
};

/** Highlights and notes on web pages (see src/annotate/). */
export interface AnnotateSettings {
  /** Offer the colour toolbar when text is selected on a page Aloud is running on. */
  toolbar: boolean;
  /** Hosts where highlights appear by themselves, once each site has been granted. */
  alwaysOn: string[];
  /** The colours to mark with, editable (see annotate/palette.ts). */
  colors: NoteColor[];
  /** Colour id for passages kept with the shortcut, the reader, or a swatch-less save. */
  defaultColor: string;
  /** Colour id for passages kept with "Add note" — so notes stand out from plain highlights. */
  noteColor: string;
  /** How new passages are marked on the page. */
  defaultStyle: NoteStyle;
  /**
   * Single keys, handled by Aloud on pages where it is already running — no browser shortcut, so
   * nothing can be taken by a browser menu. `''` switches one off.
   */
  pageKeys: { keep: string; panel: string };
}

/** A colour notes can be marked with. `id` is what notes store; label and fill are yours to change. */
export interface NoteColor {
  id: string;
  label: string;
  /** `#rrggbb`. */
  fill: string;
}

export type NoteStyle = 'highlight' | 'underline';

export const DEFAULT_NOTE_COLORS: NoteColor[] = [
  { id: 'yellow', label: 'Yellow', fill: '#ffd83a' },
  { id: 'green', label: 'Green', fill: '#7fe08a' },
  { id: 'blue', label: 'Blue', fill: '#8cc8ff' },
  { id: 'pink', label: 'Pink', fill: '#ff9fd0' },
  { id: 'purple', label: 'Purple', fill: '#c3a6ff' },
];

export const DEFAULT_ANNOTATE: AnnotateSettings = {
  toolbar: true,
  alwaysOn: [],
  pageKeys: { keep: 'k', panel: 'n' },
  colors: DEFAULT_NOTE_COLORS,
  defaultColor: 'yellow',
  noteColor: 'blue',
  defaultStyle: 'highlight',
};

export interface Settings {
  /** Video and audio speed control (see `MediaSpeedSettings`). */
  mediaSpeed: MediaSpeedSettings;
  /** Highlights and notes on web pages (see `AnnotateSettings`). */
  annotate: AnnotateSettings;
  /** Active synthesis engine. */
  engine: EngineId;
  /** Piper voice key, e.g. `en_US-hfc_female-medium`. Must exist in models.json. */
  piperVoice: string;
  /** Kokoro voice key, e.g. `af_heart`. */
  kokoroVoice: string;
  /** Supertonic voice-style key, e.g. `F1`. */
  supertonicVoice: string;
  /** Supertonic flow-matching denoising steps (more = better, slower). 3–8 is sensible. */
  supertonicSteps: number;
  /**
   * Parallel synthesis workers for the neural engines. `0` = auto (from the engine, the
   * browser's GPU access and the CPU core count — see src/synth-host/entry.ts). Higher lets the
   * slow CPU path keep up with playback, at the cost of one in-memory model copy per worker.
   * On the GPU path extra workers only add memory pressure, so auto returns 1 there.
   */
  synthWorkers: number;
  /** Speaking rate multiplier applied at the model level (pitch-preserving). */
  speed: number;
  /** Try the WebGPU execution provider before falling back to WASM. */
  preferWebGPU: boolean;
  /** Highlight the sentence currently being spoken. */
  highlight: boolean;
  /** CSS color for the sentence highlight background. */
  highlightColor: string;
  /**
   * How to mark the word being spoken, inside the sentence highlight: a darker shade of the
   * highlight colour, an underline, or not at all. Only voices whose model reports when each
   * sound plays can do it (Piper, Kokoro); Supertonic keeps the sentence highlight alone.
   */
  wordHighlight: WordHighlightStyle;
  /**
   * Give highlighted text a readable colour when the page's own colour would disappear into the
   * highlight — pale grey on a light page, light text on a dark one. Only the sentences that need
   * it change; everything else keeps the page's own colours.
   */
  highlightReadable: boolean;
  /** How the page follows the current sentence. */
  scrollMode: ScrollMode;
  /** How a PDF is shown in Aloud's reader page. */
  pdfView: PdfView;
  /**
   * Deliberate silence inserted before a chunk that starts a new block (paragraph, list
   * item, heading, …), in milliseconds. `0` = the old fully gapless behaviour.
   */
  sectionPauseMs: number;
  /** Extra silence inserted between every sentence, in milliseconds. `0` = none. */
  sentencePauseMs: number;
  /** Replace URLs with a spoken placeholder instead of reading them out. */
  skipUrls: boolean;
  /** Expand common abbreviations ("e.g." -> "for example"). */
  expandAbbreviations: boolean;
  /** Click a sentence in the page while reading to jump playback there. */
  tapToSeek: boolean;
  /** Your own "say this when you see that" fixes, applied to spoken text only. */
  pronunciations: PronunciationRule[];
  /** Parts of an article to pass over when reading the whole page. */
  skip: SkipSettings;
  /** Read a page with a downloaded voice in its language, when the current voice speaks another. */
  matchPageLanguage: boolean;
  /** Colour theme for every surface Aloud draws. */
  theme: ThemeChoice;
  /**
   * Whether the one-time tips card has already been shown above the control bar. Set the first
   * time a reader session starts, so the card teaches the controls once and never again.
   */
  tipsSeen: boolean;
  /** Verbose console logging. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'piper',
  piperVoice: 'en_GB-alba-medium',
  kokoroVoice: 'af_heart',
  supertonicVoice: 'F1',
  supertonicSteps: 4,
  synthWorkers: 0,
  speed: 1,
  mediaSpeed: DEFAULT_MEDIA_SPEED,
  annotate: DEFAULT_ANNOTATE,
  preferWebGPU: true,
  highlight: true,
  highlightColor: 'rgba(255, 214, 10, 0.45)',
  wordHighlight: 'darker',
  highlightReadable: true,
  scrollMode: 'keep-visible',
  pdfView: 'pages',
  sectionPauseMs: 0,
  sentencePauseMs: 0,
  skipUrls: true,
  expandAbbreviations: true,
  tapToSeek: true,
  pronunciations: [],
  skip: DEFAULT_SKIP,
  matchPageLanguage: true,
  theme: 'system',
  tipsSeen: false,
  debug: false,
};

/** The stored settings' schema version; each step up has a migration below. */
export const SETTINGS_VERSION = 6;

type Migration = (prev: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
    // v5 -> v6: the preset speeds became 0.25× to 4×, the range people actually jump between.
    // Only a profile still on the old default moves; presets someone typed are theirs.
    6(prev: Record<string, unknown>): Record<string, unknown> {
      const media = prev.mediaSpeed as { presets?: number[] } | undefined;
      if (media?.presets?.join(',') !== '1,1.25,1.5,1.75,2,2.5,3') return prev;
      return { ...prev, mediaSpeed: { ...media, presets: [...DEFAULT_MEDIA_SPEED.presets] } };
    },
    // v4 -> v5: Kokoro has one model now, the quantised one (measured: full precision was no
    // faster for four times the download), so the precision choice is gone.
    // Also: the word mark became a choice of style, since an underline on every word can be a
    // distraction — a darker shade is the quieter default.
    5(prev: Record<string, unknown>): Record<string, unknown> {
      const next = { ...prev };
      delete next.kokoroDtype;
      if (typeof next.wordHighlight === 'boolean') next.wordHighlight = next.wordHighlight ? 'darker' : 'off';
      return next;
    },
    // v3 -> v4: the default Piper voice became Alba (en_GB), which simply sounds better than the
    // old one. Only moved for profiles still on that old default, so a deliberate choice stands.
    4(prev: Record<string, unknown>): Record<string, unknown> {
      return prev.piperVoice === 'en_US-hfc_female-medium'
        ? { ...prev, piperVoice: 'en_GB-alba-medium' }
        : prev;
    },
    // v2 -> v3: the manifest used to list Kokoro voices in nine languages, but kokoro-js only
    // ships English (ids starting `a` = US, `b` = UK). A saved French or Japanese voice would fail
    // on every sentence, so reset it to the default rather than carry it forward.
    3(prev: Record<string, unknown>): Record<string, unknown> {
      const voice = prev.kokoroVoice;
      if (typeof voice === 'string' && !/^[ab][fm]_/.test(voice)) {
        return { ...prev, kokoroVoice: 'af_heart' };
      }
      return prev;
    },
    // v1 -> v2: the boolean `autoScroll` became the `scrollMode` enum.
    2(prev: Record<string, unknown>): Record<string, unknown> {
      const next = { ...prev };
      if (!('scrollMode' in next)) {
        next.scrollMode = next.autoScroll === false ? 'off' : 'keep-visible';
      }
      delete next.autoScroll;
      return next;
    },
};

const item = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
  version: SETTINGS_VERSION,
  migrations: MIGRATIONS,
});

/** Settings saved at schema `version` (a backup from an older Aloud), brought up to date. */
export function migrateSettings(raw: Record<string, unknown>, version: number): Record<string, unknown> {
  let next = { ...raw };
  for (let v = Math.max(1, Math.floor(version)) + 1; v <= SETTINGS_VERSION; v++) next = MIGRATIONS[v]?.(next) ?? next;
  return next;
}

/**
 * Stored settings with every missing key given its default — one level deep for grouped
 * settings, so a new skip option also gets its default in a profile that saved the group before
 * it existed.
 */
export function withDefaults(stored: Partial<Settings> | null | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    skip: { ...DEFAULT_SKIP, ...stored?.skip },
    annotate: {
      ...DEFAULT_ANNOTATE,
      ...stored?.annotate,
      pageKeys: { ...DEFAULT_ANNOTATE.pageKeys, ...stored?.annotate?.pageKeys },
    },
    mediaSpeed: {
      ...DEFAULT_MEDIA_SPEED,
      ...stored?.mediaSpeed,
      keys: { ...DEFAULT_MEDIA_SPEED.keys, ...stored?.mediaSpeed?.keys },
    },
  };
}


/**
 * Settings from outside — a restored backup — with every value checked against what it means.
 *
 * `withDefaults` fills in what is missing; this is about what is *present and wrong*: a negative
 * speed, an engine that does not exist, a colour list that is null. Those reach the reader, the
 * bar and the page marks, and a file should not be able to put them there.
 */
export function sanitizeSettings(raw: Settings): Settings {
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  const colors = Array.isArray(raw.annotate?.colors)
    ? raw.annotate.colors.filter(
        (c): c is NoteColor => !!c && typeof c.id === 'string' && typeof c.label === 'string' && typeof c.fill === 'string',
      )
    : [];
  const hosts = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((h): h is string => typeof h === 'string' && h.length > 0) : [];
  const presets = Array.isArray(raw.mediaSpeed?.presets)
    ? raw.mediaSpeed.presets.filter((p): p is number => typeof p === 'number' && p > 0 && p <= 16)
    : [];
  return {
    ...raw,
    engine: oneOf(raw.engine, ['piper', 'kokoro', 'supertonic'] as const, DEFAULT_SETTINGS.engine),
    piperVoice: typeof raw.piperVoice === 'string' && raw.piperVoice ? raw.piperVoice : DEFAULT_SETTINGS.piperVoice,
    kokoroVoice: typeof raw.kokoroVoice === 'string' && raw.kokoroVoice ? raw.kokoroVoice : DEFAULT_SETTINGS.kokoroVoice,
    supertonicVoice: typeof raw.supertonicVoice === 'string' && raw.supertonicVoice ? raw.supertonicVoice : DEFAULT_SETTINGS.supertonicVoice,
    speed: clamp(raw.speed, 0.5, 4, DEFAULT_SETTINGS.speed),
    supertonicSteps: Math.round(clamp(raw.supertonicSteps, 2, 10, DEFAULT_SETTINGS.supertonicSteps)),
    synthWorkers: Math.round(clamp(raw.synthWorkers, 0, 6, DEFAULT_SETTINGS.synthWorkers)),
    sectionPauseMs: clamp(raw.sectionPauseMs, 0, 5000, DEFAULT_SETTINGS.sectionPauseMs),
    sentencePauseMs: clamp(raw.sentencePauseMs, 0, 5000, DEFAULT_SETTINGS.sentencePauseMs),
    theme: oneOf(raw.theme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    scrollMode: oneOf(raw.scrollMode, ['off', 'keep-visible', 'snap'] as const, DEFAULT_SETTINGS.scrollMode),
    pdfView: oneOf(raw.pdfView, ['pages', 'reflow'] as const, DEFAULT_SETTINGS.pdfView),
    wordHighlight: oneOf(raw.wordHighlight, ['darker', 'underline', 'off'] as const, DEFAULT_SETTINGS.wordHighlight),
    highlightColor: typeof raw.highlightColor === 'string' && raw.highlightColor ? raw.highlightColor : DEFAULT_SETTINGS.highlightColor,
    pronunciations: Array.isArray(raw.pronunciations)
      ? raw.pronunciations.filter((r) => !!r && typeof r.from === 'string' && typeof r.to === 'string')
      : [],
    annotate: {
      ...DEFAULT_ANNOTATE,
      ...raw.annotate,
      colors: colors.length ? colors : DEFAULT_NOTE_COLORS,
      defaultStyle: oneOf(raw.annotate?.defaultStyle, ['highlight', 'underline'] as const, DEFAULT_ANNOTATE.defaultStyle),
      alwaysOn: hosts(raw.annotate?.alwaysOn),
      pageKeys: {
        keep: typeof raw.annotate?.pageKeys?.keep === 'string' ? raw.annotate.pageKeys.keep.slice(0, 1) : DEFAULT_ANNOTATE.pageKeys.keep,
        panel: typeof raw.annotate?.pageKeys?.panel === 'string' ? raw.annotate.pageKeys.panel.slice(0, 1) : DEFAULT_ANNOTATE.pageKeys.panel,
      },
    },
    mediaSpeed: {
      ...DEFAULT_MEDIA_SPEED,
      ...raw.mediaSpeed,
      step: clamp(raw.mediaSpeed?.step, 0.01, 1, DEFAULT_MEDIA_SPEED.step),
      preferred: clamp(raw.mediaSpeed?.preferred, 0.25, 5, DEFAULT_MEDIA_SPEED.preferred),
      startAt: clamp(raw.mediaSpeed?.startAt, 0, 5, DEFAULT_MEDIA_SPEED.startAt),
      presets: presets.length ? presets : [...DEFAULT_MEDIA_SPEED.presets],
      alwaysOn: hosts(raw.mediaSpeed?.alwaysOn),
      keys: { ...DEFAULT_MEDIA_SPEED.keys, ...raw.mediaSpeed?.keys },
    },
  };
}

export async function getSettings(): Promise<Settings> {
  return withDefaults(await item.getValue());
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  // Two settings saved at once — the bar's speed and the options page's theme — used to keep
  // only one of them: each read the whole object and wrote its own copy back.
  return withStorageLock('settings', async () => {
    const next = { ...(await getSettings()), ...patch };
    await item.setValue(next);
    return next;
  });
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return item.watch((newValue) => cb(withDefaults(newValue)));
}

/** The voice key the given settings select for their active engine. */
export function activeVoice(s: Settings): string {
  switch (s.engine) {
    case 'kokoro':
      return s.kokoroVoice;
    case 'supertonic':
      return s.supertonicVoice;
    default:
      return s.piperVoice;
  }
}

/** The settings key that holds the voice for the given engine. */
export function voiceKeyFor(engine: EngineId): 'piperVoice' | 'kokoroVoice' | 'supertonicVoice' {
  switch (engine) {
    case 'kokoro':
      return 'kokoroVoice';
    case 'supertonic':
      return 'supertonicVoice';
    default:
      return 'piperVoice';
  }
}
