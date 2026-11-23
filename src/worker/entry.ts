/**
 * Synthesis Worker entry point. Bundled separately (scripts/build-worker.mjs) to `public/
 * tts-worker.js` as an ES module worker, because ONNX Runtime Web relies on `import.meta.url`
 * and a runtime `import()` of its WASM loader `.mjs`.
 *
 * `worker-guard` is imported first, on purpose: it installs the global error/rejection
 * listeners before any heavy dependency evaluates, so a crash during module evaluation is
 * reported to the content script instead of surfacing as an opaque "worker crashed".
 */
import { flushEarlyMessages } from './worker-guard';

/**
 * The worker itself (engine/worker-main.ts) is a file of its own, loaded from here by its address,
 * so that this file is imported by nothing.
 *
 * It has to be. The engines are separate files that import what they share with the worker (the
 * model cache, the time stretch), and when that was part of this file they imported this file.
 * Chromium and Firefox hand them the copy that is already running. WebKit does not count a module
 * worker's own file among the modules it has loaded: it loaded and ran it a second time, and that
 * second copy took over the worker's messages with no voice loaded. Every sentence then failed
 * with "engine not initialised", straight after the voice had loaded: in Safari, Aloud never said
 * a word.
 *
 * By its address rather than a plain `import('@/engine/worker-main')`: the bundler would put its
 * own helper for such imports in this file and have the other import it from here, which is the
 * same fault again. scripts/build-worker.mjs builds worker-main as a second entry, at this
 * address, and stops the build if any file imports this one.
 *
 * Messages that arrive meanwhile are kept by worker-guard, as before.
 */
const main = new URL('./vendor/rt/worker-main.js', self.location.href).href;
(import(/* @vite-ignore */ main) as Promise<typeof import('@/engine/worker-main')>)
  .then(({ startWorker }) => flushEarlyMessages(startWorker()))
  .catch((err: unknown) => {
    try {
      (self as unknown as Worker).postMessage({
        kind: 'error',
        id: 0,
        phase: 'startup',
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        fatal: true,
      });
    } catch {
      /* noop */
    }
  });
