/**
 * Synthesis-host page script (see public/synth-host.html).
 *
 * Why this page exists: Firefox does **not** let a content script create a `Worker` from a
 * `moz-extension://` URL. This page *is* at the extension origin (and under the extension CSP,
 * so `wasm-unsafe-eval` is allowed for ONNX Runtime Web), so it can.
 *
 * What it does: it owns a **pool** of identical synthesis Workers and load-balances `synthesize`
 * requests across them. The heavy neural engines run several times slower than real-time on
 * Firefox's single WASM thread (no `SharedArrayBuffer`, and `navigator.gpu` is not exposed to
 * workers on Firefox), so one worker can't keep up with playback of a long article. N workers,
 * each synthesising a different sentence, brings the *effective* rate below real-time.
 *
 * Start-up is progressive: worker 0 is spawned first and, the moment it is ready, `ready` is
 * forwarded to the content script so playback can begin — the remaining workers are spawned in
 * the background and join the round-robin as they come up. This is what stops "loading…" from
 * hanging for a minute while 8 models compile at once.
 *
 * Built by scripts/build-worker.mjs as a plain IIFE so public/synth-host.html can load it with a
 * same-origin classic `<script src>`.
 */
import type { EngineConfig, WorkerRequest, WorkerResponse } from '@/engine/protocol';

const WORKER_URL = new URL('/tts-worker.js', location.href).href;

/** Collect transferable ArrayBuffers anywhere in a (shallow) message tree. */
function collectBuffers(value: unknown, out: ArrayBuffer[], depth = 0): void {
  if (value == null || depth > 4) return;
  if (value instanceof ArrayBuffer) {
    out.push(value);
  } else if (ArrayBuffer.isView(value)) {
    out.push((value as ArrayBufferView).buffer as ArrayBuffer);
  } else if (Array.isArray(value)) {
    for (const v of value) collectBuffers(v, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectBuffers(v, out, depth + 1);
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Hard ceiling on pool size regardless of the setting — each worker is a full model copy. */
const MAX_POOL = 6;

/** Auto pool size: Piper is already faster than real-time; the neural engines are not. */
function autoPoolSize(engine: EngineConfig['engine']): number {
  const hc = Math.max(1, navigator.hardwareConcurrency || 4);
  if (engine === 'piper') return 1;
  // Supertonic is ~real-time already and ~260 MB per copy — only a little help, kept cheap.
  if (engine === 'supertonic') return clamp(hc - 2, 1, 2);
  // Kokoro is the heaviest (~3× real-time) but small (q8 ≈ 86 MB).
  return clamp(hc - 2, 2, 4);
}

let port: MessagePort | null = null;
let disposed = false;

let initMsg: Extract<WorkerRequest, { kind: 'init' }> | null = null;
let targetSize = 1;
const allWorkers: Worker[] = [];
const readyWorkers: Worker[] = [];
let rr = 0;

let readyForwarded = false;
let maxProgress = 0;

function relay(data: unknown): void {
  if (!port) return;
  const buffers: ArrayBuffer[] = [];
  collectBuffers(data, buffers);
  try {
    port.postMessage(data, buffers);
  } catch {
    /* port gone */
  }
}

function fatalToContent(phase: string, message: string, stack?: string): void {
  if (readyForwarded) return; // only the init handshake can be failed this way
  readyForwarded = true;
  port?.postMessage({ kind: 'error', id: 0, fatal: true, phase: `synth-host:${phase}`, message, stack });
}

function makeWorker(idx: number): Worker | null {
  let w: Worker;
  try {
    w = new Worker(WORKER_URL, { type: 'module', name: `aloud-tts-${idx}` });
  } catch (err) {
    fatalToContent(`new Worker(${idx})`, err instanceof Error ? err.message : String(err));
    return null;
  }
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => onWorkerMessage(w, ev.data);
  w.onerror = (ev: ErrorEvent) => {
    ev.preventDefault?.();
    const where =
      ev.filename && ev.filename !== '' ? ` (${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0})` : '';
    fatalToContent(
      `worker[${idx}].onerror`,
      (ev.message || ev.error?.message || 'the synthesis worker failed to start') + where,
      ev.error?.stack,
    );
  };
  w.onmessageerror = () =>
    fatalToContent(`worker[${idx}].onmessageerror`, 'worker sent an unreadable message');
  return w;
}

function onWorkerMessage(w: Worker, data: WorkerResponse | undefined): void {
  if (!port || !data || typeof data !== 'object') return;

  switch (data.kind) {
    case 'ready':
      if (!readyWorkers.includes(w)) readyWorkers.push(w);
      if (!readyForwarded) {
        readyForwarded = true;
        relay(data); // playback can start now — the rest of the pool fills in behind it
        spawnRest();
      }
      return;

    case 'model-progress':
      // Each file downloads once (navigator.locks); forward a monotonic max so the bar is smooth.
      if (data.progress >= maxProgress) {
        maxProgress = data.progress;
        relay(data);
      }
      return;

    case 'error':
      if (data.fatal) {
        if (!readyForwarded) {
          readyForwarded = true;
          relay(data);
        }
      } else {
        relay(data); // a per-sentence synthesis error
      }
      return;

    default:
      relay(data); // 'audio', 'cancelled', …
  }
}

/** After worker 0 is ready, bring the rest of the pool up, lightly staggered. */
function spawnRest(): void {
  for (let i = allWorkers.length; i < targetSize; i++) {
    const idx = i;
    setTimeout(() => {
      if (disposed || !initMsg || allWorkers.length >= targetSize) return;
      const w = makeWorker(idx);
      if (!w) return;
      allWorkers.push(w);
      w.postMessage(initMsg);
    }, (idx - 1) * 700);
  }
}

function broadcast(msg: WorkerRequest): void {
  for (const w of allWorkers) {
    try {
      w.postMessage(msg);
    } catch {
      /* noop */
    }
  }
}

function teardown(): void {
  disposed = true;
  for (const w of allWorkers) {
    try {
      w.terminate();
    } catch {
      /* noop */
    }
  }
  allWorkers.length = 0;
  readyWorkers.length = 0;
  rr = 0;
}

function handleFromContent(msg: WorkerRequest): void {
  if (!msg || typeof msg !== 'object') return;

  if (msg.kind === 'init') {
    teardown();
    disposed = false;
    readyForwarded = false;
    maxProgress = 0;

    const engine = msg.config.engine;
    const requested = msg.config.workers ?? 0;
    targetSize =
      engine === 'piper'
        ? 1
        : requested > 0
          ? clamp(requested, 1, MAX_POOL)
          : autoPoolSize(engine);

    // Pooled Kokoro forces q8 weights: N full-precision copies (~320 MB each) would exhaust
    // memory, and q8's small per-worker speed cost is dwarfed by the parallelism.
    const config: EngineConfig =
      targetSize > 1 && engine === 'kokoro' ? { ...msg.config, dtype: 'q8' } : msg.config;
    initMsg = { ...msg, config };

    // eslint-disable-next-line no-console
    console.info(`[aloud] synth-host: pool target ${targetSize} worker(s) for ${engine}`);

    const w0 = makeWorker(0);
    if (!w0) return;
    allWorkers.push(w0);
    w0.postMessage(initMsg);
    return;
  }

  if (msg.kind === 'synthesize') {
    const pool = readyWorkers.length ? readyWorkers : allWorkers;
    if (pool.length === 0) return;
    const w = pool[rr % pool.length]!;
    rr++;
    const buffers: ArrayBuffer[] = [];
    collectBuffers(msg, buffers);
    try {
      w.postMessage(msg, buffers);
    } catch {
      /* noop */
    }
    return;
  }

  if (msg.kind === 'dispose') {
    broadcast(msg);
    teardown();
    return;
  }

  // 'cancel', 'set-speed', anything else → every worker.
  broadcast(msg);
}

// The content script transfers us one MessagePort; everything flows over it after that.
window.addEventListener('message', (ev: MessageEvent) => {
  const data = ev.data as { __aloud?: string } | null;
  if (!data || data.__aloud !== 'port' || !ev.ports[0]) return;

  port = ev.ports[0];
  port.onmessage = (pev: MessageEvent<WorkerRequest>) => handleFromContent(pev.data);
  port.start?.();
  port.postMessage({ __aloud: 'host-ready' });
});

window.addEventListener('pagehide', teardown);
