/**
 * Synthesis-host page script (see public/synth-host.html).
 *
 * Why this page exists: Firefox does **not** let a content script create a `Worker` from a
 * `moz-extension://` URL. This page *is* at the extension origin (and under the extension CSP,
 * so `wasm-unsafe-eval` is allowed for ONNX Runtime Web), so it can. Chromium would let the
 * content script construct the Worker directly, but routing both browsers through this page
 * keeps one code path rather than two.
 *
 * What it does: it owns a **pool** of identical synthesis Workers and feeds them `synthesize`
 * requests from a single queue (see job-queue.ts) — one sentence per idle worker at a time. On
 * the CPU path the heavy neural engines run several times slower than real time — Firefox gives
 * extension workers no `SharedArrayBuffer` (so ONNX Runtime is stuck on one WASM thread) and no
 * `navigator.gpu` — so one worker cannot keep up with playback of a long article, while N
 * workers each synthesising a different sentence bring the *effective* rate below real time.
 * Where the GPU is reachable the pool collapses to one worker; see autoPoolSize().
 *
 * Start-up is progressive: worker 0 is spawned first and, the moment it is ready, `ready` is
 * forwarded to the content script so playback can begin — the remaining workers are spawned in
 * the background and pull from the queue as they come up. This is what stops "loading…" from
 * hanging for a minute while 8 models compile at once, and the shared queue is what stops the
 * reader's opening burst of requests from all landing on worker 0.
 *
 * Built by scripts/build-worker.mjs as a plain IIFE so public/synth-host.html can load it with a
 * same-origin classic `<script src>`.
 */
import type { EngineConfig, WorkerRequest, WorkerResponse } from '@/engine/protocol';
import { capabilities } from '@/shared/browser-env';
import { probeGpu } from '@/shared/gpu-probe';
import { JobQueue } from './job-queue';
import { MAX_POOL, autoPoolSize, clampPool, poolSizeForProvider } from './pool-size';

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

/** What the pool sizing needs to know about the machine it is running on. */
function poolEnv(): { cores: number; touchFirst: boolean } {
  return {
    cores: Math.max(1, navigator.hardwareConcurrency || 4),
    touchFirst: capabilities().touchFirst,
  };
}

let port: MessagePort | null = null;
let disposed = false;

let initMsg: Extract<WorkerRequest, { kind: 'init' }> | null = null;
let targetSize = 1;
/** True when the user pinned a worker count in settings — never second-guess that. */
let poolIsFixed = false;
/** Bumped per `init`, so a probe still running for a superseded init cannot start a stale pool. */
let initGeneration = 0;
/**
 * Synthesis requests that arrived while the GPU probe was still running.
 *
 * Sizing the pool needs the probe, so worker 0 is now created one microtask-chain later than it
 * used to be. Anything the content script sends in that window is held here rather than dropped
 * — a dropped `synthesize` is a sentence that never plays.
 */
const preStartRequests: WorkerRequest[] = [];
const allWorkers: Worker[] = [];
const readyWorkers: Worker[] = [];

type SynthesizeRequest = Extract<WorkerRequest, { kind: 'synthesize' }>;

/** One queue for the whole pool; a worker is given the next sentence only when it is free. */
const jobs = new JobQueue<Worker, SynthesizeRequest>(
  (worker, job) => {
    const buffers: ArrayBuffer[] = [];
    collectBuffers(job, buffers);
    try {
      worker.postMessage(job, buffers);
    } catch {
      /* worker gone */
    }
    dispatched.set(job.chunkIndex, { at: performance.now(), worker });
    // eslint-disable-next-line no-console
    console.info(
      `[aloud] ${clock()} ${workerName(worker)} ← chunk ${job.chunkIndex} ` +
        `"${preview(job.text)}" (${job.text.length} chars) · ${poolState()}`,
    );
  },
  (job) => job.chunkIndex,
);

/** Worker names are for debugging, so they keep counting up as workers are replaced. */
let nextWorkerId = 0;

/**
 * Pipeline logging.
 *
 * This is the one place that sees the whole picture — which worker got which sentence, when, how
 * deep the queue was, and how long the answer took — so it is the only place that logs it. The
 * worker and the engine used to log a line each, from two clocks, with no worker identity and no
 * queue state, which made it impossible to tell a slow sentence from a starved pool.
 *
 * Every line is stamped with seconds since the pool started, so the log reads as a timeline.
 */
const workerIds = new WeakMap<Worker, number>();
const dispatched = new Map<number, { at: number; worker: Worker }>();
let poolStart = 0;

function clock(): string {
  return `${((performance.now() - poolStart) / 1000).toFixed(1)}s`.padStart(7);
}

function workerName(worker: Worker): string {
  const id = workerIds.get(worker);
  return id == null ? 'w?' : `w${id}`;
}

/** "queue 9 · busy 3/4" — what the pool is doing at this instant. */
function poolState(): string {
  return `queue ${jobs.pendingCount} · busy ${jobs.busyCount}/${readyWorkers.length}`;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 32 ? flat : `${flat.slice(0, 31)}…`;
}

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
  workerIds.set(w, idx);
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
    case 'ready': {
      if (!readyWorkers.includes(w)) readyWorkers.push(w);
      // eslint-disable-next-line no-console
      console.info(
        `[aloud] ${clock()} ${workerName(w)} ready on ${data.executionProvider} · ${poolState()}`,
      );
      // A worker that has just come up is idle by definition — give it work immediately.
      jobs.pump(readyWorkers);
      if (!readyForwarded) {
        readyForwarded = true;
        relay(data); // playback can start now — the rest of the pool fills in behind it
        resizePoolForProvider(data.executionProvider);
        spawnRest();
      }
      return;
    }

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
        // This sentence is over for this worker, however badly — let it take the next one.
        if (data.chunkIndex != null) jobs.release(w, readyWorkers);
        relay(data); // a per-sentence synthesis error
      }
      return;

    case 'audio': {
      // Read the length *before* relaying: the buffer is transferred, and detached after that.
      const seconds = data.sampleRate > 0 ? data.pcm.byteLength / 4 / data.sampleRate : 0;
      const started = dispatched.get(data.chunkIndex);
      dispatched.delete(data.chunkIndex);
      const took = started ? (performance.now() - started.at) / 1000 : 0;
      // Logged before the worker is released, so the line that caused the next dispatch comes
      // before it: the log then reads straight down as cause and effect.
      // eslint-disable-next-line no-console
      console.info(
        `[aloud] ${clock()} ${workerName(w)} → chunk ${data.chunkIndex} in ${took.toFixed(1)}s ` +
          `→ ${seconds.toFixed(1)}s audio · RTF ${seconds > 0 ? (took / seconds).toFixed(2) : '?'}× · ` +
          poolState(),
      );
      jobs.release(w, readyWorkers);
      relay(data);
      return;
    }

    case 'cancelled':
      jobs.release(w, readyWorkers);
      relay(data);
      return;

    default:
      relay(data);
  }
}

/** After worker 0 is ready, bring the rest of the pool up, lightly staggered. */
function spawnRest(): void {
  for (let i = allWorkers.length; i < targetSize; i++) {
    const delay = (i - 1) * 700;
    setTimeout(() => {
      if (disposed || !initMsg || allWorkers.length >= targetSize) return;
      const w = makeWorker(nextWorkerId++);
      if (!w) return;
      allWorkers.push(w);
      w.postMessage(initMsg);
    }, delay);
  }
}

/**
 * Throw a worker away and start a fresh one in its place.
 *
 * This is the only way to stop synthesis that is already running. `engine.synthesize()` is a
 * blocking WASM call, so a worker in the middle of one does not read its messages at all — a
 * `cancel` sits unseen until the sentence finishes, which on the CPU path is up to a minute for a
 * long sentence. Measured on a real seek: three of four workers spent 40-65 s each finishing
 * sentences the user had already skipped past, while the sentence they had jumped to waited for
 * the one worker that happened to be free.
 *
 * Terminating costs a model reload, but the weights are already in the cache, so a replacement is
 * ready in a few seconds — against up to a minute of a worker being useless.
 */
function replaceWorker(worker: Worker): void {
  const all = allWorkers.indexOf(worker);
  if (all >= 0) allWorkers.splice(all, 1);
  const ready = readyWorkers.indexOf(worker);
  if (ready >= 0) readyWorkers.splice(ready, 1);
  jobs.forget(worker);
  try {
    worker.terminate();
  } catch {
    /* already gone */
  }

  if (disposed || !initMsg || allWorkers.length >= targetSize) return;
  const replacement = makeWorker(nextWorkerId++);
  if (!replacement) return;
  allWorkers.push(replacement);
  replacement.postMessage(initMsg);
}

/**
 * A seek or a speed change: drop the queue, and decide what to do about work already running.
 *
 * `keepAhead` says how many sentences from the new position are still wanted. A worker inside
 * that window is left alone — the reader is about to ask for that very sentence again, and the
 * queue recognises the duplicate rather than starting it twice. Every other busy worker is
 * replaced, because it cannot be told to stop.
 */
function handleCancel(msg: Extract<WorkerRequest, { kind: 'cancel' }>): void {
  jobs.clear();

  const from = msg.fromChunkIndex;
  const until = from + Math.max(0, msg.keepAhead);
  const kept = new Set<Worker>();
  const dropped: string[] = [];

  for (const [worker, job] of jobs.busyJobs()) {
    if (job.chunkIndex >= from && job.chunkIndex < until) kept.add(worker);
    else {
      dropped.push(`${workerName(worker)}:${job.chunkIndex}`);
      dispatched.delete(job.chunkIndex);
      replaceWorker(worker);
    }
  }

  // eslint-disable-next-line no-console
  console.info(
    `[aloud] ${clock()} seek to ${from}: dropped queue, ` +
      (dropped.length > 0
        ? `terminated ${dropped.join(', ')} (mid-sentence, cannot be interrupted)`
        : 'no worker needed replacing') +
      `${kept.size > 0 ? `, kept ${kept.size} in the new window` : ''}`,
  );

  // Kept workers must not see the cancel: it would bump their generation and make them throw away
  // the sentence they are about to deliver.
  for (const worker of allWorkers) {
    if (kept.has(worker)) continue;
    try {
      worker.postMessage(msg);
    } catch {
      /* noop */
    }
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
  jobs.reset();
}

async function startPool(msg: Extract<WorkerRequest, { kind: 'init' }>, gen: number): Promise<void> {
  const engine = msg.config.engine;
  const requested = msg.config.workers ?? 0;
  // The log is a timeline of this pool, so its clock starts here.
  poolStart = performance.now();
  nextWorkerId = 0;
  dispatched.clear();

  // Ask the machine, don't assume the browser: on Chromium `navigator.gpu` exists everywhere,
  // but plenty of desktops hand back no adapter, and sizing the pool as if they had one is what
  // left Kokoro stuck at ~3× real time with a single worker there. Costs a few ms, once.
  const probe = engine === 'piper' ? { available: false, status: 'unsupported', adapterInfo: undefined } : await probeGpu();
  if (disposed || gen !== initGeneration) return; // superseded by a newer init while probing

  poolIsFixed = requested > 0;
  targetSize =
    engine === 'piper'
      ? 1
      : poolIsFixed
        ? clampPool(requested)
        : autoPoolSize(engine, probe.available, poolEnv());

  initMsg = msg;

  // eslint-disable-next-line no-console
  console.info(
    `[aloud] ${clock()} pool target ${targetSize} worker(s) for ${engine} ` +
      `(gpu ${probe.status}${probe.adapterInfo ? `: ${probe.adapterInfo}` : ''})`,
  );

  const w0 = makeWorker(nextWorkerId++);
  if (!w0) return;
  allWorkers.push(w0);
  w0.postMessage(initMsg);

  for (const held of preStartRequests.splice(0)) handleFromContent(held);
}

/**
 * Re-size the pool once worker 0 reports the provider it actually got.
 *
 * The pre-flight probe runs in this document; the worker is where synthesis happens. If they
 * disagree — a browser that grants the GPU to documents but not to workers, an adapter lost
 * between the two — the worker wins, and a pool that was sized for a GPU that never arrived
 * grows here instead of leaving playback to stall behind one CPU worker.
 */
function resizePoolForProvider(provider: string): void {
  if (!initMsg || poolIsFixed) return;
  const engine = initMsg.config.engine;
  if (engine === 'piper') return;
  const wanted = poolSizeForProvider(engine, provider, poolEnv());
  if (wanted <= targetSize) return;
  // eslint-disable-next-line no-console
  console.info(
    `[aloud] ${clock()} engine reported "${provider}"; growing pool ${targetSize} → ${wanted} worker(s)`,
  );
  targetSize = wanted;
}

function handleFromContent(msg: WorkerRequest): void {
  if (!msg || typeof msg !== 'object') return;

  if (msg.kind === 'init') {
    teardown();
    disposed = false;
    readyForwarded = false;
    maxProgress = 0;
    initMsg = null;
    preStartRequests.length = 0;
    void startPool(msg, ++initGeneration);
    return;
  }

  // The pool is still being sized (the GPU probe is in flight). Hold anything that must reach a
  // worker; drop only what is meaningless without one.
  if (allWorkers.length === 0 && !disposed) {
    if (msg.kind === 'synthesize' || msg.kind === 'cancel' || msg.kind === 'set-speed') {
      preStartRequests.push(msg);
    }
    if (msg.kind !== 'dispose') return;
  }

  if (msg.kind === 'synthesize') {
    // Straight into the shared queue: it is handed to a worker the moment one is free, which may
    // be now, or may be when the third model finishes compiling ten seconds from now.
    jobs.submit(msg, readyWorkers);
    return;
  }

  if (msg.kind === 'cancel') {
    handleCancel(msg);
    return;
  }

  if (msg.kind === 'dispose') {
    broadcast(msg);
    teardown();
    return;
  }

  // 'set-speed', anything else → every worker.
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
