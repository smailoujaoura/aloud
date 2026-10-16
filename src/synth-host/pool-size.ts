/**
 * How many synthesis workers to run.
 *
 * The pool exists to work around slow *CPU* synthesis. Piper is comfortably faster than real
 * time and needs one worker; Kokoro and Supertonic are not, so several workers each take a
 * different sentence and the *effective* rate drops below real time. Measured on a 14-core
 * desktop with Kokoro q8 on WASM: one worker runs at ~3.2× real time — it can never keep up —
 * while four bring the effective rate under 1× and playback stops stalling between sentences.
 *
 * That reasoning inverts when a worker can reach the GPU: every worker would queue onto the same
 * device, so parallelism buys nothing while each copy still costs VRAM and its own shader
 * compilation. One worker is then both faster to start and lighter.
 *
 * The decisive input is therefore whether there is *actually* a GPU — a probed fact, never "this
 * is Chromium". Chromium exposes `navigator.gpu` on every desktop, including the many where
 * `requestAdapter()` returns null (no Vulkan driver on Linux, blocklisted GPU, remote desktop).
 * Sizing the pool at 1 on those machines is precisely what made Kokoro *slower* on Chromium than
 * on Firefox, which had no GPU expectation and correctly ran four workers.
 *
 * Kept free of globals so the policy can be tested directly.
 */
import type { EngineId } from '@/shared/settings';

/** Hard ceiling on pool size regardless of the setting — each worker is a full model copy. */
export const MAX_POOL = 6;

export interface PoolEnvironment {
  /** `navigator.hardwareConcurrency`, floored at 1. */
  cores: number;
  /** Phones: slow cores and a hard memory ceiling, so never pool. */
  touchFirst: boolean;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Clamp a user-pinned worker count into the supported range. */
export function clampPool(requested: number): number {
  return clamp(Math.round(requested), 1, MAX_POOL);
}

export function autoPoolSize(engine: EngineId, gpu: boolean, env: PoolEnvironment): number {
  if (engine === 'piper') return 1;
  if (gpu) return 1;
  if (env.touchFirst) return 1;

  const cores = Math.max(1, env.cores);
  // Supertonic 3 runs at about 1.2× real time per worker at its default 5 steps (the bench), so two
  // keep ahead of the listener — and each copy holds about 1.1 GB, so never more than two.
  if (engine === 'supertonic') return clamp(cores - 2, 1, 2);
  // Kokoro is the heaviest (~3× real-time) but small (q8 ≈ 86 MB).
  return clamp(cores - 2, 2, 4);
}

/**
 * The pool size the engine's *actual* execution provider justifies.
 *
 * Worker 0 reports the provider it ended up on (`ready.executionProvider`), which is the only
 * fully trustworthy signal: the pre-flight probe runs in the synth-host document, and a browser
 * may grant a document a GPU it does not grant a worker. So the pool is re-sized once the truth
 * is in, and grows if the GPU turned out not to be there.
 */
export function poolSizeForProvider(engine: EngineId, provider: string, env: PoolEnvironment): number {
  return autoPoolSize(engine, provider.startsWith('webgpu'), env);
}
