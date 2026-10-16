/**
 * How far ahead to synthesise, how much to buffer before the first note, and how finely to chop
 * sentences — per engine, and per what the machine can actually do.
 *
 * These are the numbers that decide whether playback stutters. They exist because the neural
 * engines are much slower than real time on the single-threaded WASM path, so the pipeline has
 * to run a long way ahead of the playhead to stay gapless. Where a Worker can reach the GPU that
 * pressure largely disappears, and running a deep queue there just wastes memory and delays the
 * first word.
 *
 * The choice is driven by the execution provider the worker *reports* (`ready.executionProvider`),
 * never by which browser this is. "Chromium ⇒ GPU" was wrong on every desktop whose
 * `requestAdapter()` returns null, and it picked the shallow GPU queue for a CPU that needs the
 * deep one — the exact combination that makes Kokoro stall between sentences.
 */
import type { EngineId } from '@/shared/settings';
import { capabilities } from '@/shared/browser-env';

/** Which execution path the engine actually ended up on. */
export type SynthBackend = 'gpu' | 'cpu';

/** Classify the worker's reported provider string ("wasm", "webgpu/fp32", …). */
export function backendOf(executionProvider: string | undefined): SynthBackend {
  return executionProvider?.startsWith('webgpu') ? 'gpu' : 'cpu';
}

export interface PipelineTuning {
  /** Sentences to keep synthesised ahead of the playhead. */
  lookahead: number;
  /** Seconds of audio to buffer before starting playback. */
  primeSeconds: number;
  /** Upper bound on chunk length (chars) before clause-splitting. Smaller = shorter underruns. */
  maxChars: number;
}

/**
 * Baseline: CPU-only synthesis — Firefox everywhere, and Chromium whenever the machine hands
 * back no GPU adapter (no Vulkan driver on Linux, blocklisted GPU, remote desktop, …).
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
 * A real GPU was acquired: the neural engines run at or below real time, so a shallow queue keeps
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

/**
 * Tuning for `engine` on `backend`.
 *
 * `backend` defaults to `'cpu'` deliberately: until the worker has said otherwise, assume the
 * slow path. Being wrong that way costs a slightly deeper queue for a few seconds; being wrong
 * the other way is a stalling reader. The real answer arrives with `ready`, which lands before
 * the first sentence is ever synthesised.
 */
export function tuningFor(engine: EngineId, backend: SynthBackend = 'cpu'): PipelineTuning {
  const caps = capabilities();
  const table = caps.touchFirst ? MOBILE_TUNING : backend === 'gpu' ? GPU_TUNING : CPU_TUNING;
  return table[engine] ?? table.piper;
}
