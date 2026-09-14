/**
 * Message protocol between the content script (main thread, owns audio + DOM) and the
 * synthesis Web Worker (extension origin, owns WASM inference + model cache).
 *
 * All large payloads (PCM) are transferred, never copied. Every request carries a monotonic
 * `id`; the worker echoes it so the client can correlate replies and cancellations.
 */
import type { EngineId } from '@/shared/settings';

export interface EngineConfig {
  engine: EngineId;
  voice: string;
  /** Kokoro only. */
  dtype: 'q8' | 'fp32';
  /** Supertonic only — flow-matching denoising steps. */
  steps?: number;
  preferWebGPU: boolean;
  speed: number;
  /**
   * How many parallel synthesis Workers the synth-host should spawn (each with its own model).
   * `0` / undefined = auto-size from the engine and `navigator.hardwareConcurrency`. The slow
   * neural engines (Kokoro ~3× real-time on single-thread WASM) only keep up with playback when
   * several sentences are synthesised at once.
   */
  workers?: number;
}

/** Client -> Worker */
export type WorkerRequest =
  | { kind: 'init'; id: number; config: EngineConfig }
  | { kind: 'synthesize'; id: number; chunkIndex: number; text: string; speed: number; voice?: string }
  | {
      kind: 'cancel';
      id: number;
      fromChunkIndex: number;
      /**
       * How many chunks from `fromChunkIndex` are still wanted.
       *
       * A **seek** invalidates the queue but not the destination: work already running on a
       * sentence inside the new window is exactly what the reader is about to ask for again, so
       * it is left to finish. A **speed change** invalidates everything, because every sentence
       * has to be re-synthesised at the new rate — that sends `0`.
       *
       * This matters because synthesis cannot be interrupted: `engine.synthesize()` blocks the
       * worker thread, so a `cancel` is not even *read* until the current sentence finishes. The
       * synth-host frees those workers by terminating them, and this is what tells it which ones
       * are worth terminating rather than letting them land.
       */
      keepAhead: number;
    }
  | { kind: 'set-speed'; id: number; speed: number }
  /**
   * "Can *you* reach the GPU?" — answered from inside the worker, which is the only context
   * whose answer counts. A document can be granted WebGPU that its workers do not get: Firefox
   * gates the two separately (`dom.webgpu.enabled` vs `dom.webgpu.workers.enabled`), so a probe
   * run on the options page proves nothing about synthesis. Loads no model.
   */
  | { kind: 'probe-gpu'; id: number }
  | { kind: 'dispose'; id: number };

/** Worker -> Client */
export type WorkerResponse =
  | { kind: 'ready'; id: number; sampleRate: number; executionProvider: string }
  /** Answer to `probe-gpu`. */
  | {
      kind: 'gpu-probe';
      id: number;
      /** `navigator.gpu.requestAdapter()` returned an adapter *in the worker*. */
      webgpu: boolean;
      /** Adapter vendor/architecture, when the browser exposes it. */
      adapterInfo?: string;
      /** Whether the adapter advertises `shader-f16` (Kokoro's fp16 path needs it). */
      shaderF16?: boolean;
      /** One sentence a human can act on. */
      detail: string;
    }
  /**
   * Something the user should know that is not an error: most importantly, that the GPU path was
   * abandoned and why. Silently running three times slower is the failure mode this prevents.
   */
  | { kind: 'notice'; id: number; message: string }
  | {
      kind: 'model-progress';
      id: number;
      /** 0..1 overall. */
      progress: number;
      loaded: number;
      total: number;
      file: string;
      phase: 'download' | 'cache' | 'compile';
    }
  | {
      kind: 'audio';
      id: number;
      chunkIndex: number;
      /** Interleaved not applicable — mono. */
      pcm: ArrayBuffer;
      sampleRate: number;
      /** When each word is spoken, for engines that can say (Piper). */
      words?: WordTiming[];
    }
  | { kind: 'cancelled'; id: number; fromChunkIndex: number }
  | {
      kind: 'error';
      id: number;
      chunkIndex?: number;
      message: string;
      fatal: boolean;
      /** JS stack trace, when one is available — surfaced to the console for diagnosis. */
      stack?: string;
      /** Which stage failed, e.g. `worker-scope`, `loading manifest`, `compiling model`. */
      phase?: string;
    };

export interface WordTiming {
  /** The word's span in the text that was synthesised: `[from, to)`. */
  from: number;
  to: number;
  /** Seconds from the start of this chunk's audio. */
  start: number;
  end: number;
}
