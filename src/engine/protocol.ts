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
  | { kind: 'cancel'; id: number; fromChunkIndex: number }
  | { kind: 'set-speed'; id: number; speed: number }
  | { kind: 'dispose'; id: number };

/** Worker -> Client */
export type WorkerResponse =
  | { kind: 'ready'; id: number; sampleRate: number; executionProvider: string }
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
      /** Optional per-word timing for future word-level highlighting. */
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
  word: string;
  /** Seconds from the start of this chunk's audio. */
  start: number;
  end: number;
}
