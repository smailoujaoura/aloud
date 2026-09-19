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

import { TransformersCache, cacheHas, fetchModelFile, setCachedFileTransform } from '@/engine/model-cache';
import { exposeNodeOutput } from '@/engine/onnx-outputs';
import { soundsOf, splitWords, wordTimes, type TextWord, type TimedSound } from '@/engine/g2p/word-timing';
import type { WordTiming } from '@/engine/protocol';
import { phonemize } from 'phonemizer';
import { loadOrt } from '@/engine/ort-loader';
import { chooseExecutionProviders } from '@/engine/runtime-env';
import { log } from '@/shared/log';
import type { SynthEngine, SynthResult, InitContext } from './types';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
type KokoroDevice = 'wasm' | 'webgpu';

/** The model file transformers.js loads for each precision (onnx-community's repo layout). */
const MODEL_FILES: Partial<Record<KokoroDtype, string>> = {
  fp32: 'model.onnx',
  fp16: 'model_fp16.onnx',
  q8: 'model_quantized.onnx',
};
const modelUrl = (dtype: KokoroDtype): string | null =>
  MODEL_FILES[dtype] ? `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/${MODEL_FILES[dtype]}` : null;

/**
 * Kokoro, like Piper, decides how many audio frames each phoneme gets before it makes a sound —
 * StyleTTS2's `pred_dur`, the model's only `Clip` (a Round clamped to at least one frame) — and
 * throws it away. Exposing it as an output gives exact word timing: one duration per input token,
 * 600 samples a frame at 24 kHz, summing to the length of the audio at any speed.
 *
 * The file is rewritten as transformers.js reads it from Aloud's cache; the name of the exposed
 * output is kept here for `synthesize` to read.
 */
let durationsOutput: string | null = null;
setCachedFileTransform((key, bytes) => {
  if (!key.includes(MODEL_ID) || !/\/onnx\/model[^/]*\.onnx$/.test(key)) return null;
  const exposed = exposeNodeOutput(bytes, 'Clip');
  if (!exposed) return null;
  durationsOutput = exposed.name;
  return exposed.model;
});

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

    // WASM path precision. Without a GPU there are also no threads, and fp32 runs no faster than
    // q8 there (measured single-threaded, same input: RTF 3.18 vs 3.15–3.24) for 4× the download
    // and 4× the RAM per pooled worker — so q8 is the default on the CPU path. fp32 is worth it on
    // the WebGPU path, which runs a single worker and has the complete kernel coverage.
    const wasmDtype: KokoroDtype = ctx.dtype === 'fp32' ? 'fp32' : 'q8';

    const load = async (device: KokoroDevice, dtype: KokoroDtype) => {
      // Into Aloud's cache first, so transformers.js reads it from there — through the transform
      // above — even on the very first run, instead of straight from the network.
      const url = modelUrl(dtype);
      if (url && !(await cacheHas(url))) {
        await fetchModelFile(url, {
          label: `Kokoro ${dtype} model`,
          onProgress: (p) => ctx.onProgress({ ...p, phase: 'download' }),
        });
      }
      return loadModel(device, dtype);
    };
    const loadModel = (device: KokoroDevice, dtype: KokoroDtype) =>
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
    /** Why each GPU attempt was abandoned, so the fallback can be explained rather than guessed. */
    const gpuFailures: Array<{ label: string; err: unknown }> = [];

    for (const a of attempts) {
      const tLoad = now();
      const label = a.device === 'webgpu' ? `webgpu/${a.dtype}` : 'wasm';
      try {
        ctx.onProgress({ file: `preparing ${a.device} model`, loaded: 0, total: 1, phase: 'compile' });
        this.tts = await this.loadWithRetry(() => load(a.device, a.dtype), label, ctx);
        this.executionProvider = label;
        log.info(`[kokoro] loaded ${this.executionProvider} in ${ms(tLoad)} ms`);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (a.device === 'webgpu') gpuFailures.push({ label, err });
        log.warn(`[kokoro] ${label} failed to load: ${String(err)}`);
      }
    }

    if (!this.tts) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'Kokoro failed to load'));

    // Landing on the CPU after asking for the GPU is a threefold slowdown, and the two reasons
    // for it call for different things from the user: a failed download is worth retrying, a GPU
    // that cannot run the model is not. Say which happened instead of just being slow.
    if (wantGpu && this.executionProvider === 'wasm' && gpuFailures.length > 0) {
      const networked = gpuFailures.every((f) => isNetworkFailure(f.err));
      ctx.onNotice?.(
        networked
          ? 'The GPU version of this voice could not be downloaded — reading on the CPU for now.'
          : 'This GPU could not run the voice, so it is running on the CPU.',
      );
      log.warn(
        `[kokoro] fell back to WASM after ${gpuFailures.map((f) => f.label).join(', ')} failed` +
          (networked ? ' (network)' : ''),
      );
    }
    // No warm-up pass: on the WASM path there is no shader compilation to hide, and a throwaway
    // synth just delays `ready` (and, across a worker pool, N of them pile up). The first real
    // sentence per worker absorbs the one-time eSpeak-NG init instead.
    this.captureModelRuns();
    log.info(
      `[kokoro] ready on ${this.executionProvider} after ${ms(t0)} ms total` +
        (durationsOutput ? ' · word timing on' : ' · word timing unavailable'),
    );
  }

  /** The last model run's input tokens and per-token durations (see `captureModelRuns`). */
  private lastRun: { ids: number[]; durations: number[] | null } | null = null;

  /**
   * kokoro-js calls its model and keeps only the waveform. Wrapping that call keeps the input
   * tokens and the durations output too — without changing what kokoro-js gets back.
   */
  private captureModelRuns(): void {
    const tts = this.tts as unknown as { model: ((inputs: Record<string, unknown>) => Promise<Record<string, unknown>>) & Record<string, unknown> };
    const model = tts?.model;
    if (!model || (model as { __aloudWrapped?: boolean }).__aloudWrapped) return;
    const wrapped = Object.assign(
      async (inputs: Record<string, unknown>) => {
        const out = await model(inputs);
        const ids = Array.from((inputs.input_ids as { data?: ArrayLike<bigint | number> })?.data ?? [], Number);
        const durations = durationsOutput ? (out[durationsOutput] as { data?: ArrayLike<number> } | undefined)?.data : undefined;
        this.lastRun = { ids, durations: durations && durations.length === ids.length ? Array.from(durations, Number) : null };
        return out;
      },
      { __aloudWrapped: true, dispose: () => (model as { dispose?: () => Promise<void> }).dispose?.(), config: model.config },
    );
    (this.tts as unknown as { model: unknown }).model = wrapped;
  }

  /**
   * When each word of `text` is spoken, from the last run's durations.
   *
   * Tokens are Kokoro's phoneme symbols; each word is phonemised on its own with the same eSpeak
   * kokoro-js uses, and the two are aligned sound by sound (engine/g2p/word-timing.ts) — the same
   * way as for Piper. The words are phonemised in one call, separated by commas, which eSpeak keeps
   * apart: one call per word costs ~15 ms each, far too much per sentence.
   */
  private async wordTimings(text: string, seconds: number, voice: string): Promise<WordTiming[] | undefined> {
    const run = this.lastRun;
    const words = splitWords(text);
    if (!run?.durations || words.length === 0 || seconds <= 0) return undefined;
    const vocab = this.vocab();
    if (!vocab) return undefined;

    const total = run.durations.reduce((a, b) => a + b, 0);
    if (total <= 0) return undefined;
    const perFrame = seconds / total;
    const sounds: TimedSound[] = [];
    let at = 0;
    run.ids.forEach((id, i) => {
      const start = at * perFrame;
      at += run.durations![i]!;
      const sym = soundsOf(vocab(id) ?? '').join('');
      if (sym) sounds.push({ sym, start, end: at * perFrame });
    });

    const language = voice.startsWith('b') ? 'en' : 'en-us';
    const perWord = await phonemizeWords(words, language);
    if (!perWord) return undefined;
    const times = wordTimes(sounds, perWord.map(soundsOf));
    const timed: WordTiming[] = [];
    words.forEach((word, i) => {
      const t = times[i];
      if (t && word.to > word.from) timed.push({ from: word.from, to: word.to, start: t.start, end: t.end });
    });
    return timed;
  }

  /** Token id -> the phoneme symbol it stands for, from kokoro-js's tokenizer. */
  private vocab(): ((id: number) => string | undefined) | null {
    const model = (this.tts as unknown as { tokenizer?: { model?: { vocab?: unknown } } })?.tokenizer?.model;
    const vocab = model?.vocab;
    if (Array.isArray(vocab)) return (id) => vocab[id] as string | undefined;
    if (vocab instanceof Map) {
      const reverse = new Map<number, string>();
      for (const [token, id] of vocab as Map<string, number>) reverse.set(id, token);
      return (id) => reverse.get(id);
    }
    if (vocab && typeof vocab === 'object') {
      const reverse = new Map<number, string>();
      for (const [token, id] of Object.entries(vocab as Record<string, number>)) reverse.set(id, token);
      return (id) => reverse.get(id);
    }
    return null;
  }

  /**
   * Load once, and give a network failure exactly one second chance.
   *
   * The GPU path needs full-precision weights (~320 MB) that the CPU path never downloads, so
   * the first GPU run on a machine is a large fresh download — and a single dropped connection
   * there was enough to push the whole session onto the CPU, where it stayed for the rest of the
   * article. Retrying once costs a second when it fails and saves a threefold slowdown when it
   * works. A failure that is *not* about the network (an unsupported operator, no adapter) is
   * not retried: it will fail identically.
   */
  private async loadWithRetry(
    attempt: () => Promise<KokoroTTS>,
    label: string,
    ctx: InitContext,
  ): Promise<KokoroTTS> {
    try {
      return await attempt();
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      log.warn(`[kokoro] ${label}: download failed (${String(err)}) — retrying once`);
      ctx.onNotice?.('The voice download was interrupted — trying again.');
      await new Promise((r) => setTimeout(r, 1200));
      return attempt();
    }
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
    this.lastRun = null;
    const usable = this.usableVoice();
    const audio = await this.tts.generate(text, { voice: usable as never, speed });
    const anyAudio = audio as unknown as { audio?: Float32Array; sampling_rate?: number };
    const pcm = anyAudio.audio ?? new Float32Array(0);
    const sampleRate = anyAudio.sampling_rate ?? this.sampleRate;
    const words = await this.wordTimings(text, pcm.length / sampleRate, usable).catch((err) => {
      log.warn('[kokoro] word timing failed:', err);
      return undefined;
    });
    if (words?.length) return { pcm, sampleRate, words };
    // Timing is not logged here: the synth-host reports both ends of every sentence from one
    // clock, with the worker it ran on and the state of the queue around it, which is the only
    // view in which a slow sentence can be told apart from a starved pool.
    return { pcm, sampleRate };
  }

  /**
   * The selected voice if the runtime has it, otherwise the default.
   *
   * Earlier manifests listed Kokoro voices in nine languages although kokoro-js only ships the
   * English ones, so a settings object saved back then can still name `ff_siwis` or `pf_dora`.
   * kokoro-js answers those with a console table and a thrown error on *every* sentence; falling
   * back once, loudly, keeps the article reading.
   */
  private usableVoice(): string {
    const known = (this.tts as unknown as { voices?: Record<string, unknown> } | null)?.voices;
    if (!known || this.voice in known) return this.voice;
    log.warn(`[kokoro] voice "${this.voice}" is not available in this runtime — using ${DEFAULT_VOICE}`);
    this.voice = DEFAULT_VOICE;
    return this.voice;
  }

  async dispose(): Promise<void> {
    await this.disposeModel();
    this.tts = null;
  }
}

/** Always present in kokoro-js's voice table, and the best-graded voice in it. */
const DEFAULT_VOICE = 'af_heart';

/**
 * Does this failure look like the network rather than the model?
 *
 * Firefox reports a dropped or blocked fetch as `TypeError: NetworkError when attempting to
 * fetch resource`, Chromium as `TypeError: Failed to fetch`; transformers.js wraps both in its
 * own message. Matching on the text is unlovely, but the alternative — treating every load
 * failure as "this GPU cannot do it" — is what silently demotes a good machine to the CPU
 * because one connection dropped.
 */
function isNetworkFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /networkerror|failed to fetch|network request failed|load failed|net::|err_|fetch resource/i.test(
    text,
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
function ms(since: number): number {
  return Math.round(now() - since);
}

/**
 * Each word's phonemes, in one eSpeak call: words joined by commas come back one part each.
 * Punctuation inside a word would split it further, so it is left out of what is phonemised
 * (alignment only needs the sounds); if the parts still do not line up one-to-one, each word is
 * phonemised on its own instead.
 */
export async function phonemizeWords(words: readonly TextWord[], language: string): Promise<string[] | null> {
  const cleaned = words.map((w) => w.token.replace(/[^\p{L}\p{N}'’]+/gu, ' ').trim());
  const sent = cleaned.map((c, i) => ({ c, i })).filter((w) => w.c);
  const out = cleaned.map(() => '');
  if (sent.length === 0) return out;
  const parts = await phonemize(sent.map((w) => w.c).join(', '), language);
  if (parts.length === sent.length) {
    sent.forEach((w, k) => (out[w.i] = parts[k] ?? ''));
    return out;
  }
  if (sent.length > 40) return null;
  for (const w of sent) out[w.i] = (await phonemize(w.c, language)).join(' ');
  return out;
}
