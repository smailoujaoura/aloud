/**
 * Piper (VITS) engine — hand-rolled ONNX Runtime Web session so we fully control the execution
 * provider, threading (single-threaded: no SharedArrayBuffer in extension contexts) and caching.
 *
 * Pipeline: text -> eSpeak-NG IPA -> phoneme ids (interleaved with the pad symbol, wrapped in
 * BOS/EOS) -> VITS -> mono float PCM.
 */
import type * as Ort from 'onnxruntime-web';

import { fetchModelFile } from '@/engine/model-cache';
import { phonemize } from '@/engine/g2p/espeak';
import { loadOrt } from '@/engine/ort-loader';
import { chooseExecutionProviders } from '@/engine/runtime-env';
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

    const eps = await chooseExecutionProviders(ctx.preferWebGPU);
    ctx.onProgress({ file: 'compiling model', loaded: 0, total: 1, phase: 'compile' });
    try {
      this.session = await this.ort.InferenceSession.create(onnxBytes, {
        executionProviders: eps,
        graphOptimizationLevel: 'all',
      });
      this.executionProvider = eps[0] ?? 'wasm';
    } catch (err) {
      if (eps[0] !== 'wasm') {
        this.session = await this.ort.InferenceSession.create(onnxBytes, {
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

  private phonemesToIds(ipa: string): number[] {
    const map = this.config.phoneme_id_map;
    const ids: number[] = [];
    const push = (sym: string) => {
      const v = map[sym];
      if (v) {
        ids.push(...v);
        if (map[PAD]) ids.push(...map[PAD]);
      }
    };
    if (map[BOS]) ids.push(...map[BOS]);
    if (map[PAD]) ids.push(...map[PAD]);

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

    if (map[EOS]) ids.push(...map[EOS]);
    return ids;
  }

  async synthesize(text: string, speed: number): Promise<SynthResult> {
    if (!this.session) throw new Error('Piper engine not initialised');

    const ipa = await phonemize(text, this.config.espeak?.voice ?? 'en-us');
    const ids = this.phonemesToIds(ipa);
    if (ids.length <= 2) return { pcm: new Float32Array(0), sampleRate: this.sampleRate };

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

    const results = await this.session.run(feeds);
    const outName = this.session.outputNames[0] ?? 'output';
    const raw = results[outName]!.data as Float32Array;
    // VITS output shape is [1, 1, samples]; the flat data is already what we want.
    const pcm = raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>);
    return { pcm, sampleRate: this.sampleRate };
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
  }
}
