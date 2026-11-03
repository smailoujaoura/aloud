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
import { parseSupertonicVoice } from '@/shared/supertonic-voices';

/** Kokoro-82M at a fixed commit of onnx-community/Kokoro-82M-v1.0-ONNX (engines/kokoro.ts). */
export const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
/**
 * Phonon: Gradium's 40m multilingual model, from an unmodified copy at a fixed commit (Gradium's is
 * gated; models.json `phonon.$source`), and its voice catalogue.
 */
export const PHONON_REVISION = '514a70f83654b3a81844cc01bbe5438254080433';
export const PHONON_VOICES_REVISION = '0ee17205f254b5abc43b266c8a0f215565c352f7';
/** Supertonic 3 at a fixed commit of Supertone/supertonic-3 (models.json `base`). */
export const SUPERTONIC_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323';

export interface EngineInfo {
  id: EngineId;
  name: string;
  /** The engine's name where room is short: its tab ("Supertonic", not "Supertonic 3"). */
  short: string;
  /** Short chip shown next to the name: what this engine is, in a few words. */
  tag: string;
  /** One or two sentences under the engine picker and in its panel. */
  blurb: string;
  /** Human-readable download footprint. */
  approxSize: string;
  /** The download when reading on a GPU takes a different, larger file (Kokoro's full precision). */
  gpuApproxSize?: string;
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
    short: 'Piper',
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
    short: 'Kokoro',
    tag: 'Best quality, wants a GPU',
    blurb:
      'The most natural and expressive of the three. With GPU acceleration it is comfortably faster ' +
      'than real time; without one it runs around 3× slower than real time and leans on parallel ' +
      'workers to keep up with playback. One download unlocks all 41 voices: English (US and UK), Spanish, French, Italian, Brazilian Portuguese and Hindi.',
    // The quantised build the CPU reads (92,361,116 bytes) or the full-precision one a GPU needs
    // (325,532,232) — the quantised one returns noise instead of speech on WebGPU — plus all 41
    // voices' own files (41 × 522,240), which come in the same download.
    approxSize: '~114 MB',
    gpuApproxSize: '~347 MB',
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
    name: 'Supertonic 3',
    short: 'Supertonic',
    tag: '31 languages, large download',
    blurb:
      'Clear, natural voices in 31 languages, many that Kokoro does not speak. Quicker with a GPU. ' +
      'One ~402 MB download gives all 10 voices, each in every language.',
    // The four networks at the pinned commit (398.1 MB) and the ten voice styles (2.9 MB).
    approxSize: '~402 MB',
    cacheHint: 'supertonic-3',
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
    // A voice is a style in a language (`F1@de`); the style's file serves every language.
    voiceFile: (voice) => `/voice_styles/${parseSupertonicVoice(voice).style}.json`,
    needsGpuForSpeed: true,
    heavyForMobile: true,
  },
  phonon: {
    id: 'phonon',
    name: 'Phonon',
    short: 'Phonon',
    tag: 'Natural, and fast on any computer',
    blurb:
      'Natural, expressive voices from Gradium that read about twice as fast as real time on an ' +
      'ordinary processor, no graphics card needed. 37 English voices, American, British and a ' +
      'cast of characters, and 65 more in French, Spanish, German and Portuguese. One download, ' +
      'every voice included. Licensed for non-commercial use only.',
    // 74.8 MB of model and 102 voices of 256 KB (decimal MB, as everywhere).
    approxSize: '~101 MB',
    // Both repositories: the model (…/phonon-40m-multilingual) and the voices (gradium/phonon-voices).
    // The 31M model Phonon used before (gradium/phonon-31m-en) matches too, so deleting clears it.
    cacheHint: '/phonon-',
    revision: PHONON_REVISION,
    voiceRevision: PHONON_VOICES_REVISION,
    requiredFiles: ['/model.q8.gguf', '/tokenizer.json', '/config.json'],
    voiceFile: (voice) => `/voices/${voice}.safetensors`,
    needsGpuForSpeed: false,
    heavyForMobile: false,
  },
  server: {
    id: 'server',
    name: 'Your own server',
    short: 'Custom',
    tag: 'A voice from your own computer',
    blurb:
      'Use a speech server you run, such as Kokoro on a PC at home or over Tailscale. Aloud sends ' +
      'each sentence to the address you enter, and only there, and plays the speech it sends back. ' +
      'Nothing to download, and as fast as your server.',
    approxSize: 'No download',
    needsGpuForSpeed: false,
    heavyForMobile: false,
  },
};

// Supertonic before Kokoro wherever engines are listed: the tabs, the walkthrough, the board.
// Phonon first: natural and fast on any computer. Your own server last: it is for people who already run one.
export const ENGINE_IDS: readonly EngineId[] = ['phonon', 'piper', 'supertonic', 'kokoro', 'server'];

/**
 * Supertonic's detail (flow-matching steps) for this device. A phone gets 3 unless its reader
 * chose otherwise: on a 2018 phone (Exynos 9810) the default 5 steps took about 9 s per 3 s of
 * speech. 3 steps is about 28% faster (on a laptop, RTF 1.3 → 0.9) and still read English, German
 * and Italian word for word; Russian slipped on one word, which 5 steps had right.
 */
export const PHONE_SUPERTONIC_STEPS = 3;
export function supertonicStepsFor(chosen: number, phone: boolean, defaultSteps: number): number {
  return phone && chosen === defaultSteps ? PHONE_SUPERTONIC_STEPS : chosen;
}

/**
 * One model reads all of the engine's voices (Kokoro, Supertonic): a worker switches voice from one
 * sentence to the next without loading anything. Piper's voices are each a model of their own.
 */
export function sharesModel(engine: EngineId): boolean {
  return engine !== 'piper';
}

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

/** What downloading `info`'s model costs on this machine: a GPU may need a larger file. */
export function downloadSize(info: EngineInfo, onGpu: boolean): string {
  return (onGpu && info.gpuApproxSize ? info.gpuApproxSize : info.approxSize).replace(/\s*\(.*\)/, '');
}

/**
 * A Kokoro voice's own file (its style vectors, 522,240 bytes each), at the address kokoro-js reads
 * it from and keeps it under in its Cache Storage store, `kokoro-voices`. kokoro-js fetches it the
 * first time a voice speaks; Aloud fetches every voice's with the model instead, so that after the
 * one download no preview and no page reaches the network again.
 */
export const KOKORO_VOICE_BYTES = 522_240;
/** Where a Supertonic voice style (F1…) is kept: the pinned commit, as models.json `base` says. */
export const supertonicStyleUrl = (style: string): string =>
  `https://huggingface.co/Supertone/supertonic-3/resolve/${SUPERTONIC_REVISION}/voice_styles/${style}.json`;

/** A Phonon voice's own file (256,136 bytes each), at the pinned commit of gradium/phonon-voices. */
export const PHONON_VOICE_BYTES = 256_136;
export const phononVoiceUrl = (voice: string): string =>
  `https://huggingface.co/gradium/phonon-voices/resolve/${PHONON_VOICES_REVISION}/voices/${voice}.safetensors`;

export const kokoroVoiceUrl = (voice: string): string =>
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${voice}.bin`;
