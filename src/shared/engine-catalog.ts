/**
 * What each synthesis engine is: its name, its size, and what it costs to run.
 *
 * These descriptions are deliberately about the *engine*, not about the machine reading them.
 * They used to be written relative to the current browser — "slow here", "works here",
 * "recommended" — which reads as noise: it does not say what is actually different about the
 * engine, and it changes under you when a probe comes back. The one fact that genuinely matters
 * is stated plainly instead: some engines are only fast with GPU acceleration.
 *
 * Whether *this* machine has that acceleration is a separate question, answered by a real probe
 * (`shared/gpu-probe.ts`, `options/gpu-check.ts`) and reported once, in the GPU section of the
 * settings page — not smeared across every label.
 */
import type { EngineId } from '@/shared/settings';

/** Kokoro-82M at a fixed commit of onnx-community/Kokoro-82M-v1.0-ONNX (engines/kokoro.ts). */
export const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
/** Supertonic-2 at a fixed commit of Supertone/supertonic-2 (models.json `base`). */
export const SUPERTONIC_REVISION = '75e6727618a02f323c720cba9478152d4bc16ca4';

export interface EngineInfo {
  id: EngineId;
  name: string;
  /** Short chip shown next to the name: what this engine is, in a few words. */
  tag: string;
  /** One or two sentences under the engine picker and in its panel. */
  blurb: string;
  /** Human-readable download footprint. */
  approxSize: string;
  /**
   * Substring of a cache key meaning "the shared model is present". Kokoro and Supertonic each
   * download one model that unlocks all their voices; Piper downloads per voice and has none.
   */
  cacheHint?: string;
  /**
   * The cache key endings that must *all* be present — the weights themselves. A config file
   * alone, or weights an earlier version used, must not make the engine look installed: a cache
   * holding only Kokoro's `config.json` used to offer all 28 of its voices as ready to read.
   */
  requiredFiles?: string[];
  /**
   * The commit the model is downloaded from (`/resolve/<revision>/`). A file cached from any
   * other revision is not the file the loader asks for: counting it, a cache from before the
   * models were pinned looked ready offline, and the engine then failed to start.
   */
  revision?: string;
  /** Where the per-voice files come from, when not `revision` (kokoro-js fetches them itself). */
  voiceRevision?: string;
  /**
   * The weights, which depend on where the engine runs: Kokoro loads full-precision weights on a
   * GPU and quantised ones on the CPU, and a cache holding only one of them cannot start the other.
   */
  weights?: { cpu: string; gpu: string };
  /**
   * The file one voice needs on top of the shared model. Without it that voice cannot start
   * offline, however complete the model is.
   */
  voiceFile?: (voice: string) => string;
  /** Comfortably faster than real time only with GPU acceleration. */
  needsGpuForSpeed: boolean;
  /** Too slow or too large to be a good idea on a phone. */
  heavyForMobile: boolean;
}

const ENGINES: Record<EngineId, EngineInfo> = {
  piper: {
    id: 'piper',
    name: 'Piper',
    tag: 'Fast, small downloads',
    blurb:
      'A small, fast neural voice. Faster than real time on any machine, including phones, with ' +
      'or without a GPU. Each voice is a separate download of 21–137 MB, by quality.',
    approxSize: '21–137 MB per voice',
    needsGpuForSpeed: false,
    heavyForMobile: false,
  },
  kokoro: {
    id: 'kokoro',
    name: 'Kokoro-82M',
    tag: 'Best quality, wants a GPU',
    blurb:
      'The most natural and expressive of the three. With GPU acceleration it is comfortably faster ' +
      'than real time; without one it runs around 3× slower than real time and leans on parallel ' +
      'workers to keep up with playback. One 86 MB download unlocks all 41 voices: English (US and UK), Spanish, French, Italian, Brazilian Portuguese and Hindi.',
    approxSize: '~86 MB',
    cacheHint: 'Kokoro-82M',
    revision: KOKORO_REVISION,
    voiceRevision: 'main',
    // What kokoro-js loads besides the weights (seen in a real cache): config and tokeniser.
    requiredFiles: ['/config.json', '/tokenizer.json', '/tokenizer_config.json'],
    weights: { cpu: '/onnx/model_quantized.onnx', gpu: '/onnx/model.onnx' },
    // kokoro-js keeps these in Cache Storage ("kokoro-voices"); readCacheSizes lists them.
    voiceFile: (voice) => `/voices/${voice}.bin`,
    needsGpuForSpeed: true,
    heavyForMobile: true,
  },
  supertonic: {
    id: 'supertonic',
    name: 'Supertonic-2',
    tag: 'Expressive, large download',
    blurb:
      'Expressive, and roughly real time without a GPU — quicker with one. A single ~262 MB ' +
      'download unlocks all 10 voices.',
    approxSize: '~262 MB',
    cacheHint: 'supertonic-2',
    // Must match `base` in scripts/models.base.json (tests/engine-pins.test.ts).
    revision: SUPERTONIC_REVISION,
    // Four separate networks, the config and the character table: any one missing and synthesis
    // cannot run (engines/supertonic.ts loads all of them before the first sentence).
    requiredFiles: [
      '/onnx/text_encoder.onnx',
      '/onnx/duration_predictor.onnx',
      '/onnx/vector_estimator.onnx',
      '/onnx/vocoder.onnx',
      '/onnx/tts.json',
      '/onnx/unicode_indexer.json',
    ],
    voiceFile: (voice) => `/voice_styles/${voice}.json`,
    needsGpuForSpeed: false,
    heavyForMobile: true,
  },
};

export const ENGINE_IDS: readonly EngineId[] = ['piper', 'kokoro', 'supertonic'];

export function engineInfo(id: EngineId): EngineInfo {
  return ENGINES[id];
}

/**
 * Every engine, in a fixed order: cheapest and most portable first.
 *
 * Fixed, rather than sorted by how well the current device runs each one, so the list does not
 * rearrange itself between visits — or a moment after loading, when the GPU probe returns.
 */
export function listEngines(): EngineInfo[] {
  return ENGINE_IDS.map((id) => ENGINES[id]);
}
