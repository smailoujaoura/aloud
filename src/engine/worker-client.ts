import { browser } from 'wxt/browser';
/**
 * Content-side wrapper around the synthesis Worker.
 *
 * The Worker cannot be created here: Firefox does not let a content script spawn a `Worker`
 * from a `moz-extension://` URL (same-origin is enforced, with no web-accessible-resource
 * exception as in Chrome — it fails instantly with an opaque "worker crashed" and the worker
 * never runs a line). Instead we load `synth-host.html` in a hidden same-extension `<iframe>`;
 * that page runs at the extension origin (and under the extension CSP, so ONNX Runtime Web gets
 * `wasm-unsafe-eval` regardless of the host page), creates the Worker, and relays its messages
 * to us over a private `MessagePort` — with any `ArrayBuffer`s transferred, not copied.
 */
import type { EngineConfig, WorkerRequest, WorkerResponse, WordTiming } from './protocol';

export interface WorkerClientCallbacks {
  onReady(info: { sampleRate: number; executionProvider: string }): void;
  onProgress(info: { progress: number; loaded: number; total: number; file: string; phase: string }): void;
  onAudio(playId: number, pcm: Float32Array, sampleRate: number, words?: WordTiming[]): void;
  onError(info: { message: string; fatal: boolean; playId?: number; stack?: string; phase?: string }): void;
}

const HOST_URL = '/synth-host.html' as const;
/** How long to wait for the hidden iframe + its worker to come up before giving up. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
  settled: boolean;
}

function deferred(): Deferred {
  const d = { settled: false } as Deferred;
  d.promise = new Promise<void>((res, rej) => {
    d.resolve = () => {
      if (!d.settled) {
        d.settled = true;
        res();
      }
    };
    d.reject = (e: Error) => {
      if (!d.settled) {
        d.settled = true;
        rej(e);
      }
    };
  });
  // Never let an unawaited rejection surface as an unhandledrejection.
  d.promise.catch(() => undefined);
  return d;
}

export class WorkerClient {
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private nextId = 1;
  private readonly wanted = new Set<number>();
  private handshake: Deferred | null = null;
  private engineReady: Deferred | null = null;

  constructor(private readonly cb: WorkerClientCallbacks) {}

  async init(config: EngineConfig): Promise<void> {
    this.dispose();

    const extOrigin = new URL(browser.runtime.getURL('/')).origin;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (ev: MessageEvent) => this.onPortMessage(ev.data);

    const handshake = (this.handshake = deferred());
    const engineReady = (this.engineReady = deferred());

    const timeout = setTimeout(() => {
      handshake.reject(
        new Error(
          `synthesis host did not come up within ${HANDSHAKE_TIMEOUT_MS / 1000}s ` +
            `(the hidden ${HOST_URL} iframe or its worker failed to start)`,
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);

    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    // Kept *on screen* (1px, transparent, behind everything, non-interactive) rather than pushed
    // off to left:-9999px. An off-screen / zero-size iframe is treated as a background document
    // by Firefox and its event loop — including the synthesis Worker's — gets timer/'`postMessage`
    // budget' throttling, which stretches the between-sentence yield in the worker to seconds and
    // is a big part of why Kokoro "pauses forever" between sentences.
    frame.style.cssText =
      'position:fixed!important;left:0!important;bottom:0!important;width:1px!important;' +
      'height:1px!important;min-width:0!important;min-height:0!important;border:0!important;margin:0!important;' +
      'padding:0!important;opacity:0!important;pointer-events:none!important;z-index:-2147483647!important;';
    frame.src = browser.runtime.getURL(HOST_URL);
    this.frame = frame;

    // The listener is attached before the frame is inserted, so `load` cannot have been missed.
    // <iframe> `error` is deliberately ignored: Firefox fires it spuriously for moz-extension
    // frames embedded in a page even when the load succeeds — the handshake timeout is the real
    // failsafe.
    frame.addEventListener('load', () => {
      // Hand the host one end of the channel; all further traffic is private to this port.
      frame.contentWindow?.postMessage({ __aloud: 'port' }, extOrigin, [channel.port2]);
    });

    (document.documentElement ?? document.body).appendChild(frame);

    try {
      await handshake.promise;
      this.send({ kind: 'init', id: this.nextId++, config });
      await engineReady.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  private onPortMessage(msg: (WorkerResponse & { __aloud?: string }) | { __aloud: string }): void {
    if ('__aloud' in msg && msg.__aloud === 'host-ready') {
      this.handshake?.resolve();
      return;
    }
    this.onMessage(msg as WorkerResponse);
  }

  private onMessage(msg: WorkerResponse): void {
    switch (msg.kind) {
      case 'ready':
        this.cb.onReady({ sampleRate: msg.sampleRate, executionProvider: msg.executionProvider });
        this.engineReady?.resolve();
        break;
      case 'model-progress':
        this.cb.onProgress({
          progress: msg.progress,
          loaded: msg.loaded,
          total: msg.total,
          file: msg.file,
          phase: msg.phase,
        });
        break;
      case 'audio': {
        const playId = msg.chunkIndex;
        if (!this.wanted.has(playId)) return; // stale (seek / speed change)
        this.wanted.delete(playId);
        this.cb.onAudio(playId, new Float32Array(msg.pcm), msg.sampleRate, msg.words);
        break;
      }
      case 'error': {
        const message = msg.phase ? `[${msg.phase}] ${msg.message}` : msg.message;
        if (msg.fatal) {
          this.handshake?.reject(new Error(message));
          this.engineReady?.reject(new Error(message));
        } else if (msg.chunkIndex != null) {
          // This sentence will never arrive. Stop counting it as in-flight, or the session can
          // never re-request it and `isPending` misreports it as still coming.
          this.wanted.delete(msg.chunkIndex);
        }
        this.cb.onError({
          message,
          fatal: msg.fatal,
          playId: msg.chunkIndex,
          stack: msg.stack,
          phase: msg.phase,
        });
        break;
      }
      case 'cancelled':
        break;
    }
  }

  /** Ask the worker to synthesise `playId` if it isn't already pending. */
  request(playId: number, text: string, speed: number): void {
    if (this.wanted.has(playId) || !this.port) return;
    this.wanted.add(playId);
    this.send({ kind: 'synthesize', id: this.nextId++, chunkIndex: playId, text, speed });
  }

  /** Seek / speed change: the worker drops its whole queue, so forget every pending request. */
  cancelFrom(playId: number): void {
    this.wanted.clear();
    this.send({ kind: 'cancel', id: this.nextId++, fromChunkIndex: playId });
  }

  isPending(playId: number): boolean {
    return this.wanted.has(playId);
  }

  private send(req: WorkerRequest): void {
    try {
      this.port?.postMessage(req);
    } catch {
      /* port closed */
    }
  }

  dispose(): void {
    if (this.port) {
      this.send({ kind: 'dispose', id: this.nextId++ });
      try {
        this.port.close();
      } catch {
        /* noop */
      }
    }
    this.port = null;
    if (this.frame) {
      this.frame.remove();
      this.frame = null;
    }
    this.wanted.clear();
    // Settle any in-flight init so its awaiter doesn't hang forever.
    this.handshake?.reject(new Error('synthesis host disposed'));
    this.engineReady?.reject(new Error('synthesis host disposed'));
    this.handshake = this.engineReady = null;
  }
}
