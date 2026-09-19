/**
 * Synthesis worker entry logic. Runs at the extension origin (so `wasm-unsafe-eval` from the
 * extension CSP applies, not the host page's), off the content-script main thread.
 *
 * Responsibilities: own the ONNX sessions, load/cache model files, and turn `synthesize`
 * requests into transferable PCM. Cancellation is cooperative — the client is authoritative
 * about which chunks it still wants; the worker just drops queued (not in-flight) jobs.
 *
 * Robustness: every step that can fail — manifest load, ORT load, model download, WASM compile,
 * synthesis — runs inside a try/catch that reports `error.message` **and** `error.stack` back
 * to the content script, tagged with the phase that failed. The engines are imported lazily so
 * that a Piper session never evaluates the (much larger) `@huggingface/transformers` +
 * `kokoro-js` graph, and a failure while evaluating it is catchable rather than fatal-at-load.
 */
import type { EngineConfig, WorkerRequest, WorkerResponse } from './protocol';
import type { SynthEngine, InitContext, ModelManifest } from './engines/types';
import { assetUrl } from './runtime-env';
import { probeGpu } from '@/shared/gpu-probe';

interface Job {
  id: number;
  chunkIndex: number;
  text: string;
  speed: number;
  /** Optional per-call voice override (Kokoro preview hot-swap). */
  voice?: string;
  /** The `generation` in effect when this job was enqueued; stale jobs are skipped. */
  gen: number;
}

let engine: SynthEngine | null = null;
/**
 * How the engine was last started, so it can be restarted on the CPU when the GPU fails at
 * synthesis time — a model can load on WebGPU and still hit a kernel the browser's WebGPU cannot
 * run (Piper's int64 GatherND on Firefox did, and every sentence came back as silence).
 */
let started: { config: EngineConfig; manifest: ModelManifest; onNotice: InitContext['onNotice']; fellBack: boolean } | null = null;
let manifest: ModelManifest | null = null;
const queue: Job[] = [];
let processing = false;
let disposed = false;
/** Bumped on every `cancel` (seek / speed change); invalidates in-flight and queued jobs. */
let generation = 0;

/**
 * Yield to the macrotask queue so a pending `cancel` message can actually be delivered between
 * synthesis jobs.
 *
 * This deliberately does NOT use `setTimeout`: the synthesis worker is owned by a hidden,
 * zero-size `synth-host` iframe, and Firefox's background/'`setTimeout` budget' throttling can
 * stretch a `setTimeout(0)` to one second or more there — which, run once per sentence, is
 * exactly the multi-second "why did Kokoro pause again" stall. A `MessageChannel` round-trip is
 * a real macrotask (so a queued `onmessage` still runs first) but is not subject to that
 * throttling.
 */
const yieldChannel = new MessageChannel();
const yieldWaiters: Array<() => void> = [];
yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
const yieldToMessages = (): Promise<void> =>
  new Promise((r) => {
    yieldWaiters.push(r);
    yieldChannel.port2.postMessage(0);
  });

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

async function loadManifest(): Promise<ModelManifest> {
  if (manifest) return manifest;
  const url = assetUrl('models.json');
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Could not fetch model manifest (${url}): ${errorInfo(err).message}`);
  }
  if (!res.ok) throw new Error(`Model manifest ${url} returned HTTP ${res.status}`);
  try {
    manifest = (await res.json()) as ModelManifest;
  } catch (err) {
    throw new Error(`Model manifest ${url} is not valid JSON: ${errorInfo(err).message}`);
  }
  return manifest;
}

async function createEngine(which: EngineConfig['engine'], m: ModelManifest): Promise<SynthEngine> {
  if (which === 'kokoro') {
    const { KokoroEngine } = await import('./engines/kokoro');
    return new KokoroEngine();
  }
  if (which === 'supertonic') {
    const { SupertonicEngine } = await import('./engines/supertonic');
    return new SupertonicEngine(m);
  }
  const { PiperEngine } = await import('./engines/piper');
  return new PiperEngine(m);
}

async function handleInit(req: Extract<WorkerRequest, { kind: 'init' }>): Promise<void> {
  let phase = 'startup';
  try {
    if (engine) {
      phase = 'disposing previous engine';
      await engine.dispose();
      engine = null;
    }

    phase = 'loading model manifest';
    const m = await loadManifest();

    const progressByFile = new Map<string, { loaded: number; total: number }>();
    let compiling = false;
    const onProgress: InitContext['onProgress'] = (p) => {
      if (p.phase === 'compile') {
        compiling = true;
      } else {
        // A download reported after "preparing" is a real download (a fallback fetching another
        // file, say): show it. A flag that stuck once set used to leave the settings page on
        // "Preparing model…" at 0% for a whole 86 MB download.
        compiling = false;
        progressByFile.set(p.file, { loaded: p.loaded, total: Math.max(p.total, p.loaded, 1) });
      }
      let loaded = 0;
      let total = 0;
      for (const v of progressByFile.values()) {
        loaded += v.loaded;
        total += v.total;
      }
      const ratio = total > 0 ? loaded / total : 0;
      post({
        kind: 'model-progress',
        id: req.id,
        progress: compiling ? Math.max(0.97, ratio) : Math.min(0.96, ratio),
        loaded,
        total,
        file: p.file,
        phase: compiling ? 'compile' : p.phase === 'cache' ? 'cache' : 'download',
      });
    };

    const onNotice: InitContext['onNotice'] = (message) => post({ kind: 'notice', id: req.id, message });

    phase = `loading ${req.config.engine} engine module`;
    engine = await createEngine(req.config.engine, m);
    started = { config: req.config, manifest: m, onNotice, fellBack: false };

    phase = `initialising ${req.config.engine} engine (voice "${req.config.voice}")`;
    await engine.init({
      voice: req.config.voice,
      steps: req.config.steps,
      preferWebGPU: req.config.preferWebGPU,
      onProgress,
      onNotice,
    });

    post({
      kind: 'ready',
      id: req.id,
      sampleRate: engine.sampleRate,
      executionProvider: engine.executionProvider,
    });
  } catch (err) {
    // Leave the worker alive so a settings change can retry with a different engine/voice.
    try {
      await engine?.dispose();
    } catch {
      /* ignore secondary failure */
    }
    engine = null;
    const { message, stack } = errorInfo(err);
    post({ kind: 'error', id: req.id, message, stack, phase, fatal: true });
  }
}

/**
 * Synthesise a job; if the GPU fails at it, restart the engine on the CPU once and try again.
 *
 * Failing over here, per worker and at most once, is what keeps a GPU that loads a model but
 * cannot run it from turning a whole article into silence.
 */
async function synthesizeOrFallBack(job: Job): ReturnType<SynthEngine['synthesize']> {
  try {
    return await engine!.synthesize(job.text, job.speed, job.voice);
  } catch (err) {
    const onGpu = engine?.executionProvider.startsWith('webgpu') ?? false;
    if (!onGpu || !started || started.fellBack) throw err;
    started.fellBack = true;
    // eslint-disable-next-line no-console
    console.warn(`[aloud] GPU synthesis failed, restarting ${started.config.engine} on the CPU:`, errorInfo(err).message);
    started.onNotice?.('The GPU could not run this voice, so it is running on the CPU instead.');
    await engine?.dispose();
    engine = await createEngine(started.config.engine, started.manifest);
    await engine.init({
      voice: started.config.voice,
      steps: started.config.steps,
      preferWebGPU: false,
      onProgress: () => undefined,
      onNotice: started.onNotice,
    });
    return engine.synthesize(job.text, job.speed, job.voice);
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0 && !disposed) {
      // `engine.synthesize` blocks the worker thread (single-threaded WASM inference), so a
      // `cancel` message sent during a long run only reaches us here, between jobs. Yield first
      // so it's processed, then re-check the queue — a seek may have just emptied it.
      const ty = Date.now();
      await yieldToMessages();
      const yieldMs = Date.now() - ty;
      if (yieldMs > 40) {
        // eslint-disable-next-line no-console
        console.warn(`[aloud] worker yield between jobs took ${yieldMs} ms (event loop throttled?)`);
      }
      if (disposed || queue.length === 0) break;

      const job = queue.shift()!;
      if (job.gen !== generation) continue; // superseded by a seek / speed change
      if (!engine) {
        post({ kind: 'error', id: job.id, chunkIndex: job.chunkIndex, message: 'engine not initialised', fatal: true });
        continue;
      }
      try {
        const result = await synthesizeOrFallBack(job);
        if (job.gen !== generation || disposed) continue; // a seek landed mid-synthesis
        const pcm = result.pcm.slice();
        post(
          {
            kind: 'audio',
            id: job.id,
            chunkIndex: job.chunkIndex,
            pcm: pcm.buffer,
            sampleRate: result.sampleRate,
            words: result.words,
          },
          [pcm.buffer],
        );
      } catch (err) {
        if (job.gen !== generation) continue;
        const { message, stack } = errorInfo(err);
        post({
          kind: 'error',
          id: job.id,
          chunkIndex: job.chunkIndex,
          message,
          stack,
          phase: 'synthesis',
          fatal: false,
        });
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * Wire up the worker message handler and return it so `entry.ts` can replay any messages that
 * arrived before this ran (see `worker-guard`).
 */
export function startWorker(): (ev: MessageEvent<WorkerRequest>) => void {
  const onMessage = async (ev: MessageEvent<WorkerRequest>): Promise<void> => {
    const req = ev.data;
    try {
      switch (req.kind) {
        case 'init':
          await handleInit(req);
          break;

        case 'synthesize':
          queue.push({
            id: req.id,
            chunkIndex: req.chunkIndex,
            text: req.text,
            speed: req.speed,
            voice: req.voice,
            gen: generation,
          });
          void drainQueue();
          break;

        case 'cancel': {
          // A seek or speed change invalidates everything queued *and* whatever synthesis is
          // running right now — the client re-requests exactly what it still wants. Bumping the
          // generation makes `drainQueue` drop the in-flight job's result and skip the rest
          // instead of grinding through now-irrelevant earlier sentences (the ~30s seek stall).
          generation++;
          queue.length = 0;
          post({ kind: 'cancelled', id: req.id, fromChunkIndex: req.fromChunkIndex });
          break;
        }

        case 'set-speed':
          // Speed travels with each synthesize request; nothing global to update.
          break;

        case 'probe-gpu': {
          // Deliberately answered from *inside* the worker and without touching a model: this is
          // the context whose GPU access decides how synthesis runs, and Firefox can grant
          // WebGPU to a document while withholding it from that document's workers.
          const probe = await probeGpu(self);
          post({
            kind: 'gpu-probe',
            id: req.id,
            webgpu: probe.available,
            adapterInfo: probe.adapterInfo,
            shaderF16: probe.shaderF16,
            detail: probe.detail,
          });
          break;
        }

        case 'dispose':
          disposed = true;
          queue.length = 0;
          await engine?.dispose();
          engine = null;
          break;
      }
    } catch (err) {
      const { message, stack } = errorInfo(err);
      post({
        kind: 'error',
        id: (req as { id?: number }).id ?? 0,
        message,
        stack,
        phase: `handling "${(req as { kind?: string }).kind ?? 'unknown'}" message`,
        fatal: req.kind === 'init',
      });
    }
  };

  self.onmessage = (ev: MessageEvent<WorkerRequest>) => void onMessage(ev);
  return self.onmessage as (ev: MessageEvent<WorkerRequest>) => void;
}
