/**
 * Kokoro-82M engine, via `kokoro-js` (+ `@huggingface/transformers`).
 *
 * We configure transformers' `env` so that:
 *   - model + tokenizer files are cached in OUR IndexedDB store (`env.customCache`), not the
 *     default Cache API, so download management is unified with the Piper path;
 *   - ONNX Runtime Web loads its WASM from the vendored copy, single-threaded, no CDN;
 *   - only remote (Hugging Face) loads are allowed.
 *
 * Note: kokoro-js fetches the small per-voice `.bin` style vectors itself via the Cache API —
 * those (a few hundred KB each) are the one exception to "everything in IndexedDB".
 */
import { KokoroTTS } from 'kokoro-js';
import { env as hfEnv } from '@huggingface/transformers';

import { TransformersCache } from '@/engine/model-cache';
import { loadOrt } from '@/engine/ort-loader';
import { chooseExecutionProviders } from '@/engine/runtime-env';
import { log } from '@/shared/log';
import type { SynthEngine, SynthResult, InitContext } from './types';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
type KokoroDevice = 'wasm' | 'webgpu';

let envConfigured = false;
async function configureTransformersEnv(): Promise<void> {
  // Register our single ORT instance so transformers uses it (globalThis[Symbol.for('onnxruntime')]).
  await loadOrt();
  if (envConfigured) return;
  hfEnv.allowLocalModels = false;
  hfEnv.allowRemoteModels = true;
  hfEnv.useBrowserCache = false;
  hfEnv.useFSCache = false;
  hfEnv.useCustomCache = true;
  hfEnv.customCache = TransformersCache;
  envConfigured = true;
}

export class KokoroEngine implements SynthEngine {
  readonly id = 'kokoro' as const;
  readonly sampleRate = 24000;
  executionProvider = 'wasm';

  private tts: KokoroTTS | null = null;
  private voice = 'af_heart';

  async init(ctx: InitContext): Promise<void> {
    const t0 = now();
    await configureTransformersEnv();
    this.voice = ctx.voice;

    const eps = await chooseExecutionProviders(ctx.preferWebGPU);
    const wantGpu = eps[0] === 'webgpu';
    log.info(`[kokoro] init: preferWebGPU=${ctx.preferWebGPU} → execution providers ${JSON.stringify(eps)}`);

    // WASM path precision. Without a GPU there are also no threads, and fp32 is only ~10%
    // faster than q8 there for 4× the download and 4× the RAM per pooled worker — so q8 is the
    // sensible default on the CPU path. fp32 is worth it on the WebGPU path, which runs a single
    // worker and where the extra precision is close to free.
    const wasmDtype: KokoroDtype = ctx.dtype === 'fp32' ? 'fp32' : 'q8';

    const load = (device: KokoroDevice, dtype: KokoroDtype) =>
      KokoroTTS.from_pretrained(MODEL_ID, {
        dtype,
        device,
        progress_callback: (p: {
          status?: string;
          file?: string;
          name?: string;
          loaded?: number;
          total?: number;
          progress?: number;
        }) => {
          // Only 'progress' events carry loaded/total; 'initiate'/'done' would zero the totals.
          if (p.status === 'progress' && (p.total ?? 0) > 0) {
            ctx.onProgress({
              file: p.file ?? p.name ?? 'model',
              loaded: p.loaded ?? 0,
              total: p.total ?? 0,
              phase: 'download',
            });
          }
        },
      });

    // Try, in order: WebGPU fp32 (kokoro-js's documented default and the config most likely to
    // have full WebGPU kernel coverage) → WebGPU fp16 → WASM (chosen precision).
    const attempts: Array<{ device: KokoroDevice; dtype: KokoroDtype }> = wantGpu
      ? [
          { device: 'webgpu', dtype: 'fp32' },
          { device: 'webgpu', dtype: 'fp16' },
          { device: 'wasm', dtype: wasmDtype },
        ]
      : [{ device: 'wasm', dtype: wasmDtype }];

    let lastErr: unknown;
    for (const a of attempts) {
      const tLoad = now();
      try {
        ctx.onProgress({ file: `preparing ${a.device} model`, loaded: 0, total: 1, phase: 'compile' });
        this.tts = await load(a.device, a.dtype);
        this.executionProvider = a.device === 'webgpu' ? `webgpu/${a.dtype}` : 'wasm';
        log.info(`[kokoro] loaded ${this.executionProvider} in ${ms(tLoad)} ms`);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        log.warn(`[kokoro] ${a.device}/${a.dtype} failed to load: ${String(err)}`);
      }
    }

    if (!this.tts) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'Kokoro failed to load'));
    // No warm-up pass: on the WASM path there is no shader compilation to hide, and a throwaway
    // synth just delays `ready` (and, across a worker pool, N of them pile up). The first real
    // sentence per worker absorbs the one-time eSpeak-NG init instead.
    log.info(`[kokoro] ready on ${this.executionProvider} after ${ms(t0)} ms total`);
  }

  private async disposeModel(): Promise<void> {
    const model = (this.tts as unknown as { model?: { dispose?: () => Promise<void> } })?.model;
    try {
      await model?.dispose?.();
    } catch {
      /* noop */
    }
  }

  async synthesize(text: string, speed: number, voice?: string): Promise<SynthResult> {
    if (!this.tts) throw new Error('Kokoro engine not initialised');
    // All Kokoro voices share one model and differ only by a style vector kokoro-js loads at
    // generation time, so an override needs no re-init — this is what makes previewing every
    // voice on the options page fast.
    if (voice) this.voice = voice;
    const t = now();
    const audio = await this.tts.generate(text, { voice: this.voice as never, speed });
    const anyAudio = audio as unknown as { audio?: Float32Array; sampling_rate?: number };
    const pcm = anyAudio.audio ?? new Float32Array(0);
    const sampleRate = anyAudio.sampling_rate ?? this.sampleRate;
    const took = ms(t);
    const audioSec = pcm.length / (sampleRate || this.sampleRate);
    log.info(
      `[kokoro] synth ${text.length} chars → ${audioSec.toFixed(1)} s audio in ${took} ms ` +
        `(RTF ${audioSec > 0 ? (took / 1000 / audioSec).toFixed(2) : '?'}×, ${this.executionProvider})`,
    );
    return { pcm, sampleRate };
  }

  async dispose(): Promise<void> {
    await this.disposeModel();
    this.tts = null;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
function ms(since: number): number {
  return Math.round(now() - since);
}
