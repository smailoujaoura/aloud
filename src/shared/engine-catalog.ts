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
   * The cache key ending that must be present too — the weights themselves. A config file alone,
   * or weights an earlier version used, must not make the engine look installed.
   */
  requiredFile?: string;
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
      'or without a GPU. Each voice is a separate 20–60 MB download.',
    approxSize: '20–60 MB per voice',
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
      'workers to keep up with playback. One 86 MB download unlocks all 28 English voices (US and UK).',
    approxSize: '~86 MB',
    cacheHint: 'Kokoro-82M',
    requiredFile: '/onnx/model_quantized.onnx',
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
