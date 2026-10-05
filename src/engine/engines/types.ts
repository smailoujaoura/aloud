import type { WordTiming } from '@/engine/protocol';

export interface SynthResult {
  /** Mono PCM, -1..1. */
  pcm: Float32Array;
  sampleRate: number;
  words?: WordTiming[];
}

export interface InitContext {
  voice: string;
  /** Supertonic denoising steps. */
  steps?: number;
  preferWebGPU: boolean;
  onProgress: (p: { file: string; loaded: number; total: number; phase: 'download' | 'cache' | 'compile' }) => void;
  /**
   * Report something the reader should know that is not a failure — "the GPU model could not be
   * downloaded, so this is running on the CPU". An engine that quietly settles for a slower path
   * leaves the user with no way to tell a slow machine from a failed download.
   */
  onNotice?: (message: string) => void;
}

export interface SynthEngine {
  readonly id: 'piper' | 'kokoro' | 'supertonic';
  readonly sampleRate: number;
  readonly executionProvider: string;
  init(ctx: InitContext): Promise<void>;
  /**
   * `speed` is a multiplier: 2 => twice as fast, pitch preserved.
   * `voice` is an optional per-call override — only Kokoro honours it (its voices share one
   * model and differ only by a style vector loaded at generation time), letting the options
   * page preview every Kokoro voice without re-initialising. Other engines ignore it.
   */
  synthesize(text: string, speed: number, voice?: string): Promise<SynthResult>;
  dispose(): Promise<void> | void;
}

export interface PiperVoiceEntry {
  label: string;
  /** BCP-47-ish language tag, e.g. `en-US`. */
  language: string;
  /** English name of the language, for grouping in the UI. */
  languageName?: string;
  quality: string;
  /** Absolute URLs (Hugging Face `resolve` links). */
  onnx: string;
  config: string;
  sha256?: { onnx?: string; config?: string };
  license: string;
  /** Total download size in bytes (onnx + config), shown before download. */
  sizeBytes?: number;
  /** URL of a short hosted preview clip (mp3). */
  sample?: string;
  numSpeakers?: number;
}

export interface SupertonicManifest {
  modelId: string;
  license: string;
  /** Base HF `resolve` URL, e.g. https://huggingface.co/Supertone/supertonic-2/resolve/main */
  base: string;
  files: { textEncoder: string; durationPredictor: string; vectorEstimator: string; vocoder: string };
  config: { tts: string; unicodeIndexer: string };
  /** SHA-256 of each network at the pinned commit in `base`, checked on download. */
  sha256?: Partial<Record<'textEncoder' | 'durationPredictor' | 'vectorEstimator' | 'vocoder', string>>;
  /** voice-style key -> metadata; the style JSON is `${base}/voice_styles/${key}.json`. */
  voices: Record<string, { label: string; gender: string }>;
  sampleRate: number;
}

/** Entry in assets/models.json. */
export interface ModelManifest {
  piper: Record<string, PiperVoiceEntry>;
  kokoro: {
    modelId: string;
    voices: Record<string, { label: string; language: string; gender: string; grade?: string }>;
    license: string;
  };
  supertonic?: SupertonicManifest;
}
