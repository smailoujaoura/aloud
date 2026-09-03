/**
 * User settings, persisted in `browser.storage.local`.
 *
 * `storage.local` (not `sync`) because voice/engine choices are device-specific and we never
 * want to accidentally sync large values. Model *files* live in IndexedDB, not here.
 */
import { storage } from 'wxt/utils/storage';

export type EngineId = 'piper' | 'kokoro' | 'supertonic';

/** How the page scrolls to follow the sentence being read. */
export type ScrollMode = 'off' | 'keep-visible' | 'snap';

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
   * Kokoro weight precision for the WASM path. `q8` (~86 MB) is the default — on Firefox's
   * single thread fp32 is only marginally faster for 4× the download and RAM. `fp32` is worth
   * it only for a single-worker setup or once WebGPU is available.
   */
  kokoroDtype: 'q8' | 'fp32';
  /** Supertonic flow-matching denoising steps (more = better, slower). 3–8 is sensible. */
  supertonicSteps: number;
  /**
   * Parallel synthesis workers for the neural engines. `0` = auto (from the engine and the CPU
   * core count). Higher = the slow engines (Kokoro especially) keep up with playback better, at
   * the cost of one extra in-memory model copy per worker.
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
  /** Verbose console logging. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'piper',
  piperVoice: 'en_US-hfc_female-medium',
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
  sectionPauseMs: 0,
  sentencePauseMs: 0,
  skipUrls: true,
  expandAbbreviations: true,
  tapToSeek: true,
  debug: false,
};

const item = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
  version: 2,
  migrations: {
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
  // Merge so new keys added in an update get their defaults.
  return { ...DEFAULT_SETTINGS, ...stored };
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
