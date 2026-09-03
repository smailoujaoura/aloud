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
import { startWorker } from '@/engine/worker-main';

try {
  const handler = startWorker();
  flushEarlyMessages(handler);
} catch (err) {
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
}
