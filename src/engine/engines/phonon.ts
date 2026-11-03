/**
 * Phonon (Gradium's Phonon 40m multilingual): natural voices in English, French, German, Spanish
 * and Portuguese, about twice as fast as real time on a single CPU thread (CC BY-NC 4.0, from an
 * unmodified copy: Gradium's is gated), through Gradium's own runtime `phonon-tts`, copied unmodified into the
 * package (vendor/phonon/, scripts/sync-assets.mjs). The runtime starts a worker of its own beside
 * this one and runs the model there in WebAssembly, on the CPU: its WebGPU path has never been
 * measured on a real graphics card (tts-bench/PHONON.md), and the CPU is already twice as fast
 * as speech. When reading faster than that, the pool adds workers (synth-host/entry.ts).
 *
 * The files come through Aloud's model cache like every other engine's: the model and each voice
 * downloaded once from the pinned revisions in models.json, checked against their SHA-256, kept
 * for offline use. The runtime takes the model only as addresses, which it fetches in its own
 * worker; it is given `blob:` addresses of the checked bytes, or, where those cannot be fetched,
 * reads them from Cache Storage (`ModelFiles`). It never reaches the network itself.
 *
 * Phonon has no speed of its own: it reads at 1×, and the worker stretches the audio to the
 * reader's speed (`fixedSpeed`, audio/time-stretch.ts). It reports no word timings; the session
 * estimates them, as for Supertonic.
 *
 * The runtime fixes its text normalisation (numbers, dates) when it loads, so each language is
 * its own loaded copy; the two most recent stay loaded, for pages that switch back and forth.
 * Phonon 31M, which it replaced, read only English well (gradium/phonon-31m-en): what a device
 * still has of it is deleted once this model is in.
 */
import { cacheClear, fetchModelFile } from '@/engine/model-cache';
import { assetUrl } from '@/engine/runtime-env';
import { phononVoiceUrl } from '@/shared/engine-catalog';
import { phononLanguage, type PhononLanguage } from '@/shared/phonon-voices';
import type { InitContext, ModelManifest, PhononManifest, SynthEngine, SynthResult } from './types';

/** The runtime's surface that this engine uses (vendor/phonon/index.d.ts). */
interface PhononRuntime {
  readonly sampleRate: number;
  readonly device: 'webgpu' | 'cpu';
  addVoice(name: string, source: Uint8Array): Promise<void>;
  synth(text: string, options?: { voice?: string }): Promise<Float32Array>;
  dispose(): void;
}
interface PhononModule {
  PhononTTS: { load(options: Record<string, unknown>): Promise<PhononRuntime> };
}

/** `run`, with what it was doing named in its error: "starting Phonon: NetworkError …". */
async function stage<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * The runtime's Cache Storage store (`CACHE_NAME` in phonon-tts's fetch.js; a test keeps them
 * equal). Its worker looks a file up there before fetching it.
 */
export const PHONON_CACHE = 'phonon-tts-v1';
/** Addresses for files only ever read from that store: `.invalid` never resolves, so a miss fails fast. */
const CACHE_ONLY = 'https://aloud.invalid/phonon/';
/** Entries a copy that crashed while starting left behind are cleared after this long. */
const STALE_MS = 10 * 60_000;

type FileUrls = { weights: string; tokenizer: string; config: string };
type FileBytes = { weights: Uint8Array; tokenizer: Uint8Array; config: Uint8Array };
type FileBlobs = { weights: Blob; tokenizer: Blob; config: Blob };

/**
 * The model's files at addresses the runtime's worker can read, for as long as one copy starts.
 *
 * Chromium: `blob:` addresses, made once. Firefox, where the synthesis worker runs in a frame
 * inside the page being read: storage there is partitioned, and a `blob:` address cannot be
 * fetched, not even by the worker that made it ("NetworkError"). There the files are put in the
 * runtime's Cache Storage under addresses of their own, for one start, and taken out after: the
 * model then lives once on disk (Aloud's store), not twice.
 *
 * Held as Blobs, not the downloaded bytes: the 75 MB of weights were kept twice in every
 * synthesis worker (the bytes, and the Blob made from them), and a browser may keep a Blob that
 * size on disk rather than in memory.
 */
class ModelFiles {
  private blobs: FileUrls | null = null;

  private constructor(private readonly files: FileBlobs) {}

  static async from(bytes: FileBytes): Promise<ModelFiles> {
    const files = new ModelFiles({
      weights: new Blob([bytes.weights as BlobPart], { type: 'application/octet-stream' }),
      tokenizer: new Blob([bytes.tokenizer as BlobPart], { type: 'application/json' }),
      config: new Blob([bytes.config as BlobPart], { type: 'application/json' }),
    });
    const probe = URL.createObjectURL(new Blob(['']));
    const blobsWork = await fetch(probe).then(
      () => true,
      () => false,
    );
    URL.revokeObjectURL(probe);
    if (blobsWork) {
      const { weights, tokenizer, config } = files.files;
      files.blobs = { weights: URL.createObjectURL(weights), tokenizer: URL.createObjectURL(tokenizer), config: URL.createObjectURL(config) };
    } else if (typeof caches === 'undefined') {
      throw new Error('this browser lets Phonon read its model neither from memory nor from Cache Storage');
    } else {
      await clearStale();
    }
    return files;
  }

  /** Are the files in the runtime's Cache Storage (rather than at `blob:` addresses)? */
  get cached(): boolean {
    return this.blobs === null;
  }

  /** `run` with the files' addresses, which last until it settles. */
  async use<T>(run: (urls: FileUrls) => Promise<T>): Promise<T> {
    if (this.blobs) return run(this.blobs);
    const store = await caches.open(PHONON_CACHE);
    const at = `${CACHE_ONLY}${Date.now()}-${crypto.randomUUID()}/`;
    const urls: FileUrls = { weights: `${at}model.q8.gguf`, tokenizer: `${at}tokenizer.json`, config: `${at}config.json` };
    try {
      for (const key of ['weights', 'tokenizer', 'config'] as const) {
        const b = this.files[key];
        await store.put(urls[key], new Response(b, { headers: { 'content-length': String(b.size) } }));
      }
      return await run(urls);
    } finally {
      await Promise.all(Object.values(urls).map((u) => store.delete(u).catch(() => false)));
    }
  }

  dispose(): void {
    if (this.blobs) for (const url of Object.values(this.blobs)) URL.revokeObjectURL(url);
    this.blobs = null;
  }
}

/** Entries of copies that never finished starting (the worker was closed meanwhile). */
async function clearStale(): Promise<void> {
  try {
    const store = await caches.open(PHONON_CACHE);
    const now = Date.now();
    for (const request of await store.keys()) {
      const stamp = Number(request.url.startsWith(CACHE_ONLY) ? request.url.slice(CACHE_ONLY.length).split('-')[0] : NaN);
      if (Number.isFinite(stamp) && now - stamp > STALE_MS) await store.delete(request);
    }
  } catch {
    /* storage blocked: nothing to clear */
  }
}

/** Languages kept loaded at once: a bilingual page alternates between two. */
const LOADED_LANGUAGES = 2;

export class PhononEngine implements SynthEngine {
  readonly id = 'phonon' as const;
  readonly fixedSpeed = true;
  readonly executionProvider = 'wasm';
  sampleRate = 24000;

  private module: PhononModule | null = null;
  private files: ModelFiles | null = null;
  /** Loaded copies of the model, by language, least recently used first. */
  private readonly loaded = new Map<PhononLanguage, Promise<PhononRuntime>>();
  /** Voices each loaded copy has been given. */
  private readonly voicesOf = new Map<PhononRuntime, Set<string>>();
  private readonly voiceBytes = new Map<string, Promise<Uint8Array>>();
  private voice = '';

  constructor(private readonly manifest: ModelManifest) {}

  private get m(): PhononManifest {
    const m = this.manifest.phonon;
    if (!m) throw new Error('models.json has no "phonon" section');
    return m;
  }

  async init(ctx: InitContext): Promise<void> {
    const m = this.m;
    this.voice = ctx.voice;
    const progress = (label: string) => (p: { loaded?: number; total?: number }) =>
      ctx.onProgress({ file: label, loaded: p.loaded ?? 0, total: Math.max(p.total ?? 0, p.loaded ?? 0, 1), phase: 'download' });

    const [weights, tokenizer, config] = await stage('downloading the Phonon model', () =>
      Promise.all([
        fetchModelFile(`${m.base}/${m.files.weights}`, { sha256: m.sha256.weights, label: 'Phonon model', onProgress: progress('Phonon model') }),
        fetchModelFile(`${m.base}/${m.files.tokenizer}`, { sha256: m.sha256.tokenizer, label: 'tokenizer' }),
        fetchModelFile(`${m.base}/${m.files.config}`, { sha256: m.sha256.config, label: 'config' }),
        this.bytesOf(ctx.voice),
      ]),
    );
    this.files = await ModelFiles.from({ weights, tokenizer, config });
    // Phonon 31M, from before: no longer read, 65 MB on disk for nothing.
    void cacheClear('gradium/phonon-31m-en').catch(() => undefined);

    ctx.onProgress({ file: 'starting Phonon', loaded: 0, total: 1, phase: 'compile' });
    this.module = await stage('loading the Phonon runtime', async () => (await import(/* @vite-ignore */ assetUrl('vendor/phonon/index.js'))) as PhononModule);
    const runtime = await stage('starting Phonon', () => this.runtimeFor(phononLanguage(this.languageOf(ctx.voice))));
    await stage('giving Phonon its voice', () => this.withVoice(runtime, ctx.voice));
    this.sampleRate = runtime.sampleRate;
  }

  async synthesize(text: string, _speed: number, voice?: string): Promise<SynthResult> {
    const name = voice || this.voice;
    const runtime = await this.runtimeFor(phononLanguage(this.languageOf(name)));
    await this.withVoice(runtime, name);
    const pcm = await runtime.synth(text, { voice: name });
    return { pcm, sampleRate: runtime.sampleRate };
  }

  async dispose(): Promise<void> {
    for (const loading of this.loaded.values()) void loading.then((r) => r.dispose()).catch(() => undefined);
    this.loaded.clear();
    this.voicesOf.clear();
    this.files?.dispose();
    this.files = null;
  }

  private languageOf(voice: string): string {
    return this.m.voices[voice]?.language ?? 'en';
  }

  /** The model loaded for `lang`, loading it (and letting the oldest go) when it is not. */
  private runtimeFor(lang: PhononLanguage): Promise<PhononRuntime> {
    const ready = this.loaded.get(lang);
    if (ready) {
      // Most recently used goes last.
      this.loaded.delete(lang);
      this.loaded.set(lang, ready);
      return ready;
    }
    const module = this.module;
    const checkpoint = this.files;
    if (!module || !checkpoint) throw new Error('Phonon engine not initialised');
    const loading = checkpoint.use((files) => module.PhononTTS.load({
      lang,
      quant: 'q8',
      model: { weights: { q8: files.weights }, tokenizer: files.tokenizer, config: files.config, voices: {} },
      // Its Cache Storage only where the files were put there (ModelFiles): reading them, it finds
      // every one and stores nothing. With `blob:` addresses it would copy each back into it.
      cache: checkpoint.cached,
      // Threads need a cross-origin-isolated page, which an extension worker is not.
      threads: 1,
      // The measured path (see the top of this file); more speed comes from more workers.
      device: 'cpu',
      workerUrl: assetUrl('vendor/phonon/worker.js'),
      wasmUrl: assetUrl('vendor/phonon/wasm/phonon_tts_bg.wasm'),
      simdWasmUrl: assetUrl('vendor/phonon/wasm/phonon_tts_simd_bg.wasm'),
    }));
    this.loaded.set(lang, loading);
    loading.catch(() => this.loaded.delete(lang));
    while (this.loaded.size > LOADED_LANGUAGES) {
      const [oldest, old] = this.loaded.entries().next().value!;
      this.loaded.delete(oldest);
      void old.then((r) => {
        this.voicesOf.delete(r);
        r.dispose();
      }).catch(() => undefined);
    }
    return loading;
  }

  private async withVoice(runtime: PhononRuntime, voice: string): Promise<void> {
    let given = this.voicesOf.get(runtime);
    if (!given) this.voicesOf.set(runtime, (given = new Set()));
    if (given.has(voice)) return;
    // The runtime copies the bytes to its worker, so the cached ones stay usable.
    await runtime.addVoice(voice, await this.bytesOf(voice));
    given.add(voice);
  }

  private bytesOf(voice: string): Promise<Uint8Array> {
    let bytes = this.voiceBytes.get(voice);
    if (!bytes) {
      const entry = this.m.voices[voice];
      if (!entry) throw new Error(`Phonon has no voice "${voice}"`);
      bytes = fetchModelFile(phononVoiceUrl(voice), { sha256: entry.sha256, label: `${entry.label} voice` });
      bytes.catch(() => this.voiceBytes.delete(voice));
      this.voiceBytes.set(voice, bytes);
    }
    return bytes;
  }
}
