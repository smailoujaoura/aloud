/**
 * How far ahead to synthesise, how much to buffer before the first note, and how finely to chop
 * sentences — per engine, and per what the browser can actually do.
 *
 * These are the numbers that decide whether playback stutters. They exist because the neural
 * engines are much slower than real time on the single-threaded WASM path, so the pipeline has
 * to run a long way ahead of the playhead to stay gapless. Where a Worker can reach the GPU
 * (Chromium) that pressure largely disappears, and running a deep queue there just wastes memory
 * and delays the first word.
 */
import type { EngineId } from '@/shared/settings';
import { capabilities } from '@/shared/browser-env';

export interface PipelineTuning {
  /** Sentences to keep synthesised ahead of the playhead. */
  lookahead: number;
  /** Seconds of audio to buffer before starting playback. */
  primeSeconds: number;
  /** Upper bound on chunk length (chars) before clause-splitting. Smaller = shorter underruns. */
  maxChars: number;
}

/**
 * Baseline: CPU-only synthesis (Firefox everywhere, Chromium without a usable GPU).
 *
 * Piper is comfortably faster than real time, so it needs only a shallow queue. Kokoro and
 * Supertonic are not, and are fed by a *pool* of workers (see src/synth-host/entry.ts), so the
 * queue must be deep enough to keep every worker busy — several jobs each.
 */
const CPU_TUNING: Record<EngineId, PipelineTuning> = {
  piper: { lookahead: 4, primeSeconds: 1.5, maxChars: 240 },
  kokoro: { lookahead: 24, primeSeconds: 3.5, maxChars: 160 },
  supertonic: { lookahead: 20, primeSeconds: 3.5, maxChars: 160 },
};

/**
 * GPU-capable browsers: the neural engines run at or below real time, so a shallow queue keeps
 * up. A deep one would only hold more decoded audio in memory and make the first word arrive
 * later. Larger chunks also help here — per-inference overhead dominates on the GPU path.
 */
const GPU_TUNING: Record<EngineId, PipelineTuning> = {
  piper: { lookahead: 4, primeSeconds: 1.5, maxChars: 240 },
  kokoro: { lookahead: 6, primeSeconds: 1.5, maxChars: 240 },
  supertonic: { lookahead: 6, primeSeconds: 1.5, maxChars: 240 },
};

/** Phones: slow cores and a hard memory ceiling, so prime longer and keep chunks short. */
const MOBILE_TUNING: Record<EngineId, PipelineTuning> = {
  piper: { lookahead: 4, primeSeconds: 2, maxChars: 200 },
  kokoro: { lookahead: 8, primeSeconds: 5, maxChars: 120 },
  supertonic: { lookahead: 8, primeSeconds: 5, maxChars: 120 },
};

export function tuningFor(engine: EngineId): PipelineTuning {
  const caps = capabilities();
  const table = caps.touchFirst ? MOBILE_TUNING : caps.workerWebGPU ? GPU_TUNING : CPU_TUNING;
  return table[engine] ?? table.piper;
}
