/**
 * User settings, persisted in `browser.storage.local`.
 *
 * `storage.local` (not `sync`) because voice/engine choices are device-specific and we never
 * want to accidentally sync large values. Model *files* live in IndexedDB, not here.
 */
import { storage } from 'wxt/utils/storage';
import type { PronunciationRule } from '@/segment/pronunciations';

export type EngineId = 'piper' | 'kokoro' | 'supertonic';

/** How the page scrolls to follow the sentence being read. */
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

export interface Settings {
  /** Active synthesis engine. */
  engine: EngineId;
  /** Piper voice key, e.g. `en_US-hfc_female-medium`. Must exist in models.json. */
  piperVoice: string;
  /** Kokoro voice key, e.g. `af_heart`. */
  kokoroVoice: string;
  /** Supertonic voice-style key, e.g. `F1`. */
  supertonicVoice: string;
  /**
   * Kokoro weight precision. `q8` (~86 MB) is the default: on the single-threaded CPU path
   * fp32 is only marginally faster for 4× the download and RAM. `fp32` is worth it on the
   * WebGPU path (Chromium), which runs one worker and absorbs the extra precision cheaply.
   */
  kokoroDtype: 'q8' | 'fp32';
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
  kokoroDtype: 'q8',
  supertonicSteps: 4,
  synthWorkers: 0,
  speed: 1,
  preferWebGPU: true,
  highlight: true,
  highlightColor: 'rgba(255, 214, 10, 0.45)',
  scrollMode: 'keep-visible',
  pdfView: 'pages',
  sectionPauseMs: 0,
  sentencePauseMs: 0,
  skipUrls: true,
  expandAbbreviations: true,
  tapToSeek: true,
  pronunciations: [],
  skip: DEFAULT_SKIP,
  theme: 'system',
  tipsSeen: false,
  debug: false,
};

const item = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
  version: 4,
  migrations: {
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
  },
});

export async function getSettings(): Promise<Settings> {
  const stored = await item.getValue();
  // Merge so new keys added in an update get their defaults — one level deep for grouped settings,
  // so a new skip option also gets its default in a profile that saved the group before it existed.
  return { ...DEFAULT_SETTINGS, ...stored, skip: { ...DEFAULT_SKIP, ...stored?.skip } };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await item.setValue(next);
  return next;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return item.watch((newValue) => cb({ ...DEFAULT_SETTINGS, ...newValue }));
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
