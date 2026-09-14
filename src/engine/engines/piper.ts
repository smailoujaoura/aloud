/**
 * Piper (VITS) engine — hand-rolled ONNX Runtime Web session so we fully control the execution
 * provider, threading (single-threaded: no SharedArrayBuffer in extension contexts) and caching.
 *
 * Pipeline: text -> piper_phonemize (eSpeak-NG, every language) -> IPA per sentence -> phoneme ids
 * (interleaved with the pad symbol, wrapped in BOS/EOS) -> VITS -> mono float PCM.
 *
 * The model is also asked for the number of frames it gave each phoneme (see `onnx-outputs.ts`),
 * which `g2p/word-timing.ts` turns into the time each written word is spoken.
 */
import type * as Ort from 'onnxruntime-web';

import { fetchModelFile } from '@/engine/model-cache';
import { phonemizeForPiper } from '@/engine/g2p/piper-phonemize';
import { loadOrt } from '@/engine/ort-loader';
import { chooseExecutionProviders } from '@/engine/runtime-env';
import { exposeNodeOutput } from '@/engine/onnx-outputs';
import { soundsOf, splitWords, wordTimes, type TimedSound } from '@/engine/g2p/word-timing';
import type { WordTiming } from '@/engine/protocol';
import type { ModelManifest, SynthEngine, SynthResult, InitContext } from './types';

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers?: number;
  speaker_id_map?: Record<string, number>;
}

const PAD = '_';
const BOS = '^';
const EOS = '$';

export class PiperEngine implements SynthEngine {
  readonly id = 'piper' as const;
  sampleRate = 22050;
  executionProvider = 'wasm';

  private ort!: typeof import('onnxruntime-web');
  private session: Ort.InferenceSession | null = null;
  private config!: PiperConfig;
  private sortedKeys: string[] = [];
  private maxKeyLen = 1;
  private speakerId: bigint | null = null;
  /** The model's per-phoneme frame counts, when they could be exposed as an output. */
  private durationsOutput: string | null = null;

  constructor(private readonly manifest: ModelManifest) {}

  async init(ctx: InitContext): Promise<void> {
    this.ort = await loadOrt();

    const entry = this.manifest.piper[ctx.voice];
    if (!entry) throw new Error(`Unknown Piper voice "${ctx.voice}"`);

    const [configBytes, onnxBytes] = await Promise.all([
      fetchModelFile(entry.config, {
        sha256: entry.sha256?.config,
        label: `${ctx.voice} config`,
        onProgress: (p) => ctx.onProgress({ ...p }),
      }),
      fetchModelFile(entry.onnx, {
        sha256: entry.sha256?.onnx,
        label: `${ctx.voice} voice`,
        onProgress: (p) => ctx.onProgress({ ...p }),
      }),
    ]);

    this.config = JSON.parse(new TextDecoder().decode(configBytes)) as PiperConfig;
    this.sampleRate = this.config.audio?.sample_rate ?? 22050;

    this.sortedKeys = Object.keys(this.config.phoneme_id_map).sort((a, b) => b.length - a.length);
    this.maxKeyLen = this.sortedKeys.reduce((m, k) => Math.max(m, [...k].length), 1);

    if ((this.config.num_speakers ?? 1) > 1) {
      const firstSpeaker = Object.values(this.config.speaker_id_map ?? { '0': 0 })[0] ?? 0;
      this.speakerId = BigInt(firstSpeaker);
    }

    // The duration predictor's `Ceil` is the frame count per phoneme id. Every Piper export has
    // exactly one; if a model does not, it still speaks, just without word timing.
    const exposed = exposeNodeOutput(new Uint8Array(onnxBytes), 'Ceil');
    const modelBytes = exposed?.model ?? onnxBytes;
    this.durationsOutput = exposed?.name ?? null;

    const eps = await chooseExecutionProviders(ctx.preferWebGPU);
    ctx.onProgress({ file: 'compiling model', loaded: 0, total: 1, phase: 'compile' });
    try {
      this.session = await this.ort.InferenceSession.create(modelBytes, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });
      this.executionProvider = eps[0] ?? 'wasm';
    } catch (err) {
      if (eps[0] !== 'wasm') {
        this.session = await this.ort.InferenceSession.create(modelBytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
        this.executionProvider = 'wasm';
      } else {
        throw err;
      }
    }
    ctx.onProgress({ file: 'compiling model', loaded: 1, total: 1, phase: 'compile' });
  }

  /**
   * IPA -> model input ids. Alongside: the phoneme symbols in order, and for each id the index of
   * the symbol it speaks (-1 for BOS, EOS and the leading pad). A pad belongs to the phoneme
   * before it — its frames are that phoneme's tail.
   */
  private phonemesToIds(ipa: string): { ids: number[]; symbols: string[]; owners: number[] } {
    const map = this.config.phoneme_id_map;
    const ids: number[] = [];
    const symbols: string[] = [];
    const owners: number[] = [];
    const emit = (values: number[] | undefined, owner: number) => {
      for (const v of values ?? []) {
        ids.push(v);
        owners.push(owner);
      }
    };
    const push = (sym: string) => {
      const v = map[sym];
      if (v) {
        symbols.push(sym);
        emit(v, symbols.length - 1);
        emit(map[PAD], symbols.length - 1);
      }
    };
    emit(map[BOS], -1);
    emit(map[PAD], -1);

    const chars = [...ipa];
    for (let i = 0; i < chars.length; ) {
      let matched = '';
      for (let len = Math.min(this.maxKeyLen, chars.length - i); len >= 1; len--) {
        const cand = chars.slice(i, i + len).join('');
        if (map[cand]) {
          matched = cand;
          break;
        }
      }
      if (matched) {
        push(matched);
        i += [...matched].length;
      } else {
        i += 1; // unknown glyph, skip
      }
    }

    emit(map[EOS], -1);
    return { ids, symbols, owners };
  }

  async synthesize(text: string, speed: number): Promise<SynthResult> {
    if (!this.session) throw new Error('Piper engine not initialised');
    const voice = this.config.espeak?.voice ?? 'en-us';

    const words = this.durationsOutput ? splitWords(text) : [];
    const phonemes = words.length
      ? await phonemizeForPiper(text, voice, words.map((w) => w.token))
      : { sentences: await phonemizeForPiper(text, voice), words: [] as string[] };

    const parts: Float32Array[] = [];
    const sounds: TimedSound[] = [];
    let offset = 0;
    for (const ipa of phonemes.sentences) {
      const { ids, symbols, owners } = this.phonemesToIds(ipa);
      if (ids.length <= 2) continue;
      if (parts.length) offset += SENTENCE_GAP_SECONDS;
      const { pcm, frames } = await this.runVits(ids, speed);
      parts.push(pcm);
      if (frames) collectSounds(sounds, symbols, owners, frames, pcm.length / this.sampleRate, offset);
      offset += pcm.length / this.sampleRate;
    }

    const pcm = joinWithPauses(parts, this.sampleRate);
    if (sounds.length === 0 || words.length === 0) return { pcm, sampleRate: this.sampleRate };

    const times = wordTimes(sounds, phonemes.words.map(soundsOf));
    const timed: WordTiming[] = [];
    words.forEach((word, i) => {
      const t = times[i];
      if (t && word.to > word.from) timed.push({ from: word.from, to: word.to, start: t.start, end: t.end });
    });
    return { pcm, sampleRate: this.sampleRate, words: timed };
  }

  private async runVits(ids: number[], speed: number): Promise<{ pcm: Float32Array; frames: number[] | null }> {
    const inf = this.config.inference ?? { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 };
    const lengthScale = inf.length_scale / Math.max(0.1, speed);

    const feeds: Record<string, Ort.Tensor> = {
      input: new this.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new this.ort.Tensor('float32', Float32Array.from([inf.noise_scale, lengthScale, inf.noise_w]), [3]),
    };
    if (this.speakerId !== null) {
      feeds.sid = new this.ort.Tensor('int64', BigInt64Array.from([this.speakerId]), [1]);
    }

    const results = await this.session!.run(feeds);
    const outName = this.session!.outputNames.find((n) => n !== this.durationsOutput) ?? 'output';
    const raw = results[outName]!.data as Float32Array;
    // VITS output shape is [1, 1, samples]; the flat data is already what we want.
    const pcm = raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>);
    const durations = this.durationsOutput ? results[this.durationsOutput] : undefined;
    const frames = durations && durations.data.length === ids.length ? Array.from(durations.data as ArrayLike<number>, Number) : null;
    return { pcm, frames };
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
  }
}

/**
 * Append the sounds of one sentence, timed from its frame counts. The model's frames are spread
 * evenly over its audio (every Piper voice uses one hop size), so a frame lasts
 * `seconds / totalFrames`.
 */
function collectSounds(
  out: TimedSound[],
  symbols: string[],
  owners: number[],
  frames: number[],
  seconds: number,
  offset: number,
): void {
  const total = frames.reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  const perFrame = seconds / total;
  const spans = symbols.map(() => ({ start: Infinity, end: -Infinity }));
  let at = 0;
  frames.forEach((count, k) => {
    const start = offset + at * perFrame;
    at += count;
    const owner = owners[k] ?? -1;
    if (owner < 0) return;
    const span = spans[owner]!;
    span.start = Math.min(span.start, start);
    span.end = Math.max(span.end, offset + at * perFrame);
  });
  symbols.forEach((symbol, i) => {
    const sym = soundsOf(symbol).join('');
    const span = spans[i]!;
    if (sym && span.end >= span.start) out.push({ sym, start: span.start, end: span.end });
  });
}

/** Piper's own runtime leaves this much silence between sentences it was handed together. */
const SENTENCE_GAP_SECONDS = 0.15;

function joinWithPauses(parts: Float32Array[], sampleRate: number): Float32Array {
  if (parts.length <= 1) return parts[0] ?? new Float32Array(0);
  const gap = Math.round(sampleRate * SENTENCE_GAP_SECONDS);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1));
  let at = 0;
  parts.forEach((part, i) => {
    out.set(part, at);
    at += part.length + (i < parts.length - 1 ? gap : 0);
  });
  return out;
}
