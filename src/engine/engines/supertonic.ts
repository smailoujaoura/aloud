/**
 * Supertonic 3 (Supertone) engine — a flow-matching TTS that runs as four ONNX graphs, in 31 languages.
 *
 * Ported from the reference browser implementation in `supertone-inc/supertonic` (`web/helper.js`).
 * Pipeline per sentence:
 *   text → NFKD + light cleanup → per-Unicode-codepoint ids (no phonemiser!)
 *   → duration_predictor  → duration (seconds)
 *   → text_encoder        → text embedding
 *   → sample gaussian latent, then N flow-matching steps through vector_estimator
 *   → vocoder             → float PCM @ 44.1 kHz
 *
 * Voice = a small precomputed "style" tensor pair (`style_ttl`, `style_dp`) fetched as JSON, and a
 * language: Aloud names them together (`F1@de`, shared/supertonic-voices.ts). Every style reads every
 * language; the language is only the tag around the text. So one loaded model reads any voice in any
 * language, sentence by sentence, as Kokoro does with its voices.
 * Because Supertonic needs no eSpeak-NG, this engine pulls in no phonemiser code at all.
 */
import type * as Ort from 'onnxruntime-web';

import { fetchModelFile } from '@/engine/model-cache';
import { loadOrt } from '@/engine/ort-loader';
import { chooseExecutionProviders } from '@/engine/runtime-env';
import type { SynthEngine, SynthResult, InitContext, ModelManifest } from './types';
import { parseSupertonicVoice } from '@/shared/supertonic-voices';

interface SupertonicCfg {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { latent_dim: number; chunk_compress_factor: number };
}

interface StyleTensorJSON {
  dims: number[];
  data: unknown;
}

const DASH_MAP: Record<string, string> = { '–': '-', '‑': '-', '—': '-', '_': ' ' };

/**
 * Mirror of `UnicodeProcessor.preprocessText` in the upstream `supertone-inc/supertonic`
 * `web/helper.js`. The crucial, easy-to-miss step is the wrapping in the language's tag
 * (`<de>…</de>`) — the model is trained only on tagged input and produces buzzing / robotic noise
 * without it, and the tag is what decides the language it reads in.
 */
function preprocessText(input: string, language: string): string {
  let text = input.normalize('NFKD');
  // Drop emoji / pictographs.
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}]/gu,
    '',
  );
  text = text
    .replace(/[–‑—_]/g, (m) => DASH_MAP[m] ?? m)
    .replace(/[“”]/g, '"')
    .replace(/[‘’´`]/g, "'")
    .replace(/[[\]|/#→←]/g, ' ')
    .replace(/[♥☆♡©\\]/g, '')
    .replace(/@/g, ' at ')
    .replace(/\be\.g\.,/gi, 'for example, ')
    .replace(/\bi\.e\.,/gi, 'that is, ')
    .replace(/ ([,.!?;:'])/g, '$1')
    .replace(/""/g, '"')
    .replace(/''/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (text && !/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += '.';
  if (!text) return '';
  return `<${language}>${text}</${language}>`;
}

function tensorFromStyle(ort: typeof Ort, s: StyleTensorJSON): Ort.Tensor {
  const flat = Float32Array.from((s.data as number[]).flat(Infinity) as number[]);
  return new ort.Tensor('float32', flat, s.dims);
}

export class SupertonicEngine implements SynthEngine {
  readonly id = 'supertonic' as const;
  sampleRate = 44100;
  executionProvider = 'wasm';

  private ort!: typeof Ort;
  private dp: Ort.InferenceSession | null = null;
  private textEnc: Ort.InferenceSession | null = null;
  private vectorEst: Ort.InferenceSession | null = null;
  private vocoder: Ort.InferenceSession | null = null;
  private indexer: Int32Array = new Int32Array(0);
  private cfg!: SupertonicCfg;
  /** Voice styles loaded so far, by style key (F1…): a voice change is a lookup, after the first. */
  private readonly styles = new Map<string, { ttl: Ort.Tensor; dp: Ort.Tensor }>();
  /** The voice set at init, used when a request names none. */
  private voice = 'F1@en';
  private steps = 5;

  constructor(private readonly manifest: ModelManifest) {}

  async init(ctx: InitContext): Promise<void> {
    this.ort = await loadOrt();
    const m = this.manifest.supertonic;
    if (!m) throw new Error('models.json has no "supertonic" section');
    this.steps = Math.max(1, Math.min(12, ctx.steps ?? 5));
    this.voice = ctx.voice;
    const { style: initialStyle } = parseSupertonicVoice(ctx.voice);

    const url = (p: string) => `${m.base}/${p}`;
    const prog = (label: string) => (p: { file?: string; loaded?: number; total?: number }) =>
      ctx.onProgress({
        file: p.file ?? label,
        loaded: p.loaded ?? 0,
        total: Math.max(p.total ?? 0, p.loaded ?? 0, 1),
        phase: 'download',
      });

    const [ttsJson, indexerJson, styleJson, dpBytes, teBytes, veBytes, voBytes] = await Promise.all([
      fetchModelFile(url(m.config.tts), { label: 'config' }),
      fetchModelFile(url(m.config.unicodeIndexer), { label: 'tokenizer' }),
      fetchModelFile(`${m.base}/voice_styles/${initialStyle}.json`, { label: `${initialStyle} style` }),
      // Each network checked against its SHA-256 at the pinned commit (models.base.json).
      fetchModelFile(url(m.files.durationPredictor), { sha256: m.sha256?.durationPredictor, label: 'duration predictor', onProgress: prog('duration predictor') }),
      fetchModelFile(url(m.files.textEncoder), { sha256: m.sha256?.textEncoder, label: 'text encoder', onProgress: prog('text encoder') }),
      fetchModelFile(url(m.files.vectorEstimator), { sha256: m.sha256?.vectorEstimator, label: 'vector estimator', onProgress: prog('vector estimator') }),
      fetchModelFile(url(m.files.vocoder), { sha256: m.sha256?.vocoder, label: 'vocoder', onProgress: prog('vocoder') }),
    ]);

    this.cfg = JSON.parse(new TextDecoder().decode(ttsJson)) as SupertonicCfg;
    this.sampleRate = this.cfg.ae?.sample_rate ?? 44100;
    this.indexer = Int32Array.from(JSON.parse(new TextDecoder().decode(indexerJson)) as number[]);

    this.styles.set(initialStyle, this.parseStyle(styleJson));

    const eps = await chooseExecutionProviders(ctx.preferWebGPU);
    ctx.onProgress({ file: 'compiling model', loaded: 0, total: 1, phase: 'compile' });
    const opts: Ort.InferenceSession.SessionOptions = {
      executionProviders: eps,
      graphOptimizationLevel: 'all',
    };
    const create = (bytes: Uint8Array) => this.ort.InferenceSession.create(bytes, opts);
    try {
      [this.dp, this.textEnc, this.vectorEst, this.vocoder] = await Promise.all([
        create(dpBytes),
        create(teBytes),
        create(veBytes),
        create(voBytes),
      ]);
      this.executionProvider = eps[0] ?? 'wasm';
    } catch (err) {
      if (eps[0] === 'wasm') throw err;
      const wasmOpts = { ...opts, executionProviders: ['wasm' as const] };
      const c2 = (bytes: Uint8Array) => this.ort.InferenceSession.create(bytes, wasmOpts);
      [this.dp, this.textEnc, this.vectorEst, this.vocoder] = await Promise.all([
        c2(dpBytes),
        c2(teBytes),
        c2(veBytes),
        c2(voBytes),
      ]);
      this.executionProvider = 'wasm';
    }
    ctx.onProgress({ file: 'compiling model', loaded: 1, total: 1, phase: 'compile' });
  }

  private parseStyle(bytes: Uint8Array): { ttl: Ort.Tensor; dp: Ort.Tensor } {
    const style = JSON.parse(new TextDecoder().decode(bytes)) as { style_ttl: StyleTensorJSON; style_dp: StyleTensorJSON };
    return { ttl: tensorFromStyle(this.ort, style.style_ttl), dp: tensorFromStyle(this.ort, style.style_dp) };
  }

  /** A voice style, from memory or the model cache (they come with the model's download). */
  private async styleFor(style: string): Promise<{ ttl: Ort.Tensor; dp: Ort.Tensor }> {
    const known = this.styles.get(style);
    if (known) return known;
    const m = this.manifest.supertonic!;
    if (!Object.hasOwn(m.voices, style)) throw new Error(`Supertonic has no voice ${style}`);
    const loaded = this.parseStyle(await fetchModelFile(`${m.base}/voice_styles/${style}.json`, { label: `${style} style` }));
    this.styles.set(style, loaded);
    return loaded;
  }

  private encodeText(text: string, language: string): { ids: BigInt64Array; len: number } {
    const chars = Array.from(preprocessText(text, language));
    const ids = new BigInt64Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const cp = chars[i]!.codePointAt(0)!;
      ids[i] = BigInt(cp < this.indexer.length ? this.indexer[cp]! : -1);
    }
    return { ids, len: chars.length };
  }

  async synthesize(text: string, speed: number, voice?: string): Promise<SynthResult> {
    if (!this.dp || !this.textEnc || !this.vectorEst || !this.vocoder) {
      throw new Error('Supertonic engine not initialised');
    }
    const ort = this.ort;
    const { style: styleKey, language } = parseSupertonicVoice(voice || this.voice);
    const languages = this.manifest.supertonic?.languages;
    if (languages?.length && !languages.includes(language)) throw new Error(`Supertonic does not read ${language}`);
    const style = await this.styleFor(styleKey);
    const { ids, len } = this.encodeText(text, language);
    if (len === 0) return { pcm: new Float32Array(0), sampleRate: this.sampleRate };

    const textIds = new ort.Tensor('int64', ids, [1, len]);
    const textMask = new ort.Tensor('float32', new Float32Array(len).fill(1), [1, 1, len]);

    const dpOut = await this.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    let durationSec = Number((dpOut.duration!.data as Float32Array | number[])[0]) / Math.max(0.1, speed);
    if (!isFinite(durationSec) || durationSec <= 0) durationSec = Math.max(0.4, len * 0.06);

    const teOut = await this.textEnc.run({
      text_ids: textIds,
      style_ttl: style.ttl,
      text_mask: textMask,
    });
    const textEmb = teOut.text_emb!;

    const latentDim = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;
    const chunkSize = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const wavLen = Math.floor(durationSec * this.sampleRate);
    // Ceil-division, matching upstream `Math.floor((wavLenMax + chunkSize - 1) / chunkSize)`.
    const latentLen = Math.max(1, Math.floor((wavLen + chunkSize - 1) / chunkSize));
    const n = latentDim * latentLen;

    let xt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u1 = Math.max(1e-4, Math.random());
      const u2 = Math.random();
      xt[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    // latent mask is all-ones here (single, unpadded utterance) — keep it explicit for the graph.
    const latentMask = new ort.Tensor('float32', new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStepT = new ort.Tensor('float32', new Float32Array([this.steps]), [1]);

    for (let step = 0; step < this.steps; step++) {
      const veOut = await this.vectorEst.run({
        noisy_latent: new ort.Tensor('float32', xt, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
        total_step: totalStepT,
      });
      xt = Float32Array.from(veOut.denoised_latent!.data as Float32Array);
    }

    const voOut = await this.vocoder.run({
      latent: new ort.Tensor('float32', xt, [1, latentDim, latentLen]),
    });
    const full = voOut.wav_tts!.data as Float32Array;
    const pcm = full.length > wavLen && wavLen > 0 ? full.slice(0, wavLen) : Float32Array.from(full);
    return { pcm, sampleRate: this.sampleRate };
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.dp?.release(),
      this.textEnc?.release(),
      this.vectorEst?.release(),
      this.vocoder?.release(),
    ]);
    this.dp = this.textEnc = this.vectorEst = this.vocoder = null;
  }
}
