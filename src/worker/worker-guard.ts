/**
 * Loaded as the *very first* module of the synthesis worker (see `entry.ts`), before ONNX
 * Runtime Web, `@huggingface/transformers`, `kokoro-js` or the eSpeak-NG WASM are pulled in.
 *
 * Its job is to make a crash legible. Without it, a failure while the worker's module graph is
 * still evaluating — or an unhandled promise rejection anywhere in the worker — reaches the
 * content script only as an opaque `ErrorEvent` whose `.message` is often empty ("worker
 * crashed"), with no hint of which layer failed. That is exactly the symptom this file exists
 * to remove.
 *
 * It:
 *   - registers `error` / `unhandledrejection` / `messageerror` listeners that forward the exact
 *     message + stack (+ file/line when the platform provides them) to the content script as a
 *     structured `{ kind: 'error', fatal: true }` response;
 *   - buffers any messages that arrive before `startWorker()` installs the real handler, so the
 *     `init` request the client sends immediately after `new Worker()` is never dropped.
 */
import type { WorkerResponse } from '@/engine/protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let reported = 0;

function postFatal(message: string, stack?: string, phase?: string): void {
  // Avoid drowning the client if something throws in a loop during teardown.
  if (reported >= 5) return;
  reported++;
  const msg: WorkerResponse = {
    kind: 'error',
    id: 0,
    message,
    stack,
    phase: phase ?? 'worker-scope',
    fatal: true,
  };
  try {
    scope.postMessage(msg);
  } catch {
    /* postMessage can itself throw while the worker is being torn down — nothing else to do */
  }
}

let earlyMessages: MessageEvent[] | null = [];

// Start receiving messages immediately; hold them until the real handler is ready.
scope.onmessage = (ev: MessageEvent) => {
  earlyMessages?.push(ev);
};

scope.addEventListener('error', (ev: ErrorEvent) => {
  const err = ev.error instanceof Error ? ev.error : undefined;
  const where =
    ev.filename != null && ev.filename !== ''
      ? ` (${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0})`
      : '';
  postFatal(
    (ev.message || err?.message || 'Uncaught error in worker scope') + where,
    err?.stack,
    'worker-scope',
  );
});

scope.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  const reason = ev.reason;
  const err = reason instanceof Error ? reason : undefined;
  postFatal(
    err?.message ?? (typeof reason === 'string' ? reason : 'Unhandled promise rejection in worker'),
    err?.stack,
    'unhandled-rejection',
  );
});

scope.addEventListener('messageerror', () => {
  postFatal('Worker could not deserialise a message from the content script', undefined, 'message-error');
});

/**
 * Replay any messages that arrived before `handler` was installed, then stop buffering. Call
 * exactly once, right after `startWorker()` has set `self.onmessage`.
 */
export function flushEarlyMessages(handler: (ev: MessageEvent) => void): void {
  const pending = earlyMessages ?? [];
  earlyMessages = null;
  for (const ev of pending) {
    try {
      handler(ev);
    } catch (err) {
      postFatal(
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : undefined,
        'message-handler',
      );
    }
  }
}
