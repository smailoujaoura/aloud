/**
 * Voice preview for the options page: let the user hear a voice before committing to it.
 *
 *  - Piper voices have a hosted sample clip (`manifest.piper[x].sample`) — we just play the mp3.
 *  - Kokoro / Supertonic have no per-voice clips, so we synthesise a short fixed sentence on
 *    device. That needs the (shared) engine model, so it only works once that model is cached.
 *
 * Design goals (this file used to spawn a throwaway worker per click, show "■ Stop" instantly
 * with no feedback, and leave the button stuck on "Stop" when a second preview was started):
 *
 *  1. **One reusable worker.** The synthesis worker (and its compiled ONNX sessions) is kept
 *     alive between previews. Re-previewing the same voice is instant; Kokoro voices all share
 *     one model, so switching between them only reloads a small style vector — no re-compile.
 *  2. **Real status.** Every preview reports `loading` (with download / prepare progress),
 *     `synthesizing`, `playing`, then `idle`, so the button can show what is actually happening.
 *  3. **Clean cancellation.** Starting any preview (or calling `stopPreview`) supersedes the
 *     previous one: its audio stops, its in-flight work is cancelled, and its status listener
 *     gets a final `idle` so its button resets itself.
 *
 * This module runs at the extension origin (the options page), so `new Worker(getURL(...))` and
 * `new AudioContext()` are both available (unlike in a content script).
 */
import { sharesModel } from '@/shared/engine-catalog';
import { browser } from 'wxt/browser';
import type { EngineConfig, WorkerResponse } from '@/engine/protocol';
import { PREVIEW_NATIVE } from './preview-sentences';

/** Kept short on purpose — every extra word is ~0.4 s more synthesis on the WASM path. */
export const PREVIEW_SENTENCE = 'This is a short sample of how the voice sounds.';

/** The same sentence in the languages synthesised on device, so a voice previews in its own. */
const PREVIEW_BY_LANGUAGE: Record<string, string> = {
  es: 'Este es un breve ejemplo de cómo suena la voz.',
  fr: 'Voici un court exemple de la façon dont sonne la voix.',
  hi: 'यह एक छोटा सा नमूना है कि आवाज़ कैसी सुनाई देती है।',
  it: 'Questo è un breve esempio di come suona la voce.',
  pt: 'Este é um pequeno exemplo de como a voz soa.',
};

/** The preview sentence for a voice speaking `language` (a tag like "pt-BR"); English otherwise. */
export function previewSentence(language: string | undefined): string {
  const code = (language ?? '').toLowerCase().split(/[-_]/)[0]!;
  return PREVIEW_BY_LANGUAGE[code] ?? PREVIEW_NATIVE[code] ?? PREVIEW_SENTENCE;
}

export type PreviewPhase = 'idle' | 'loading' | 'synthesizing' | 'playing';

export interface PreviewStatus {
  phase: PreviewPhase;
  /** 0..1 while a model is loading; omitted otherwise. */
  progress?: number;
  /** `download` while bytes are arriving, `compile` while ORT builds the session. */
  loadKind?: 'download' | 'compile';
  /** Which execution provider the engine came up on, e.g. `webgpu/fp16` or `wasm`. */
  engineInfo?: string;
  /** Set instead of advancing a phase when something went wrong. */
  error?: string;
}

type StatusFn = (s: PreviewStatus) => void;
const NOOP: StatusFn = () => {};

// ---- shared playback -------------------------------------------------------

let sharedCtx: AudioContext | null = null;
let activeAudio: AudioBufferSourceNode | HTMLAudioElement | null = null;

function stopAudio(): void {
  if (!activeAudio) return;
  try {
    if (activeAudio instanceof HTMLAudioElement) {
      activeAudio.pause();
      activeAudio.removeAttribute('src');
    } else {
      activeAudio.onended = null;
      activeAudio.stop();
    }
  } catch {
    /* noop */
  }
  activeAudio = null;
}

// ---- reusable synthesis worker -------------------------------------------

interface Pending {
  /** Request id this handler set is waiting on; messages for other ids are ignored. */
  expectId?: number;
  onReady?: (executionProvider: string) => void;
  onAudio?: (pcm: Float32Array, sampleRate: number) => void;
  onError?: (err: Error) => void;
  onProgress?: (p: { progress: number; phase: 'download' | 'cache' | 'compile' }) => void;
}

/** Execution provider of the currently warm engine (`webgpu/fp16`, `wasm`, …). */
let warmEngineInfo = '';

let worker: Worker | null = null;
/** `configKey` of the engine currently initialised in `worker`; empty when none / unknown. */
let warmKey = '';
let pending: Pending = {};
let nextId = 1;

/** Kokoro's and Supertonic's voices share a model, so the voice is not part of their warm key. */
function configKey(c: EngineConfig): string {
  const voice = sharesModel(c.engine) ? '*' : c.voice;
  return [c.engine, voice, c.steps ?? '', c.preferWebGPU].join('|');
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(browser.runtime.getURL('/tts-worker.js'), {
    type: 'module',
    name: 'aloud-preview',
  });
  worker = w;
  warmKey = '';
  warmEngineInfo = '';
  w.onerror = (ev) => {
    ev.preventDefault?.();
    warmKey = '';
    worker = null;
    try {
      w.terminate();
    } catch {
      /* noop */
    }
    pending.onError?.(new Error(ev.message || 'preview worker crashed'));
  };
  w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    // Ignore replies that belong to a superseded request (a stale init still finishing, etc.).
    if (pending.expectId != null && 'id' in m && m.id !== pending.expectId) return;
    switch (m.kind) {
      case 'model-progress':
        pending.onProgress?.({ progress: m.progress, phase: m.phase });
        break;
      case 'ready':
        pending.onReady?.(m.executionProvider);
        break;
      case 'audio':
        pending.onAudio?.(new Float32Array(m.pcm), m.sampleRate);
        break;
      case 'error':
        if (m.fatal) warmKey = '';
        pending.onError?.(new Error(m.phase ? `[${m.phase}] ${m.message}` : m.message));
        break;
      default:
        break;
    }
  };
  return w;
}

function teardownWorker(): void {
  if (worker) {
    try {
      worker.postMessage({ kind: 'dispose', id: nextId++ });
    } catch {
      /* noop */
    }
    try {
      worker.terminate();
    } catch {
      /* noop */
    }
  }
  worker = null;
  warmKey = '';
  pending = {};
}

// ---- one-preview-at-a-time orchestration --------------------------------

let token = 0;
let currentListener: StatusFn = NOOP;

/** Cancel whatever preview is running, resetting its listener. Returns the new token. */
function supersede(): number {
  token++;
  stopAudio();
  // Reject the previous preview's outstanding await so its async body unwinds instead of hanging.
  pending.onError?.(new Error('superseded'));
  pending = {};
  if (worker) {
    // Drop any in-flight synthesis but keep the warm engine.
    try {
      worker.postMessage({ kind: 'cancel', id: nextId++, fromChunkIndex: 0 });
    } catch {
      /* noop */
    }
  }
  currentListener({ phase: 'idle' });
  currentListener = NOOP;
  return token;
}

/** Stop the current preview (if any). Keeps the warm worker for the next one. */
export function stopPreview(): void {
  supersede();
}

/** Full teardown — call when the options page is going away. */
export function disposePreview(): void {
  supersede();
  teardownWorker();
  if (sharedCtx && sharedCtx.state !== 'closed') void sharedCtx.close().catch(() => undefined);
  sharedCtx = null;
}

// ---- entry points -------------------------------------------------------

/** Play a hosted clip (Piper). Never rejects — failures come back through `onStatus`. */
export function playClip(url: string, onStatus: StatusFn = NOOP): Promise<void> {
  const my = supersede();
  currentListener = onStatus;
  onStatus({ phase: 'loading' });

  return new Promise<void>((resolve) => {
    const audio = new Audio(url);
    audio.preload = 'auto';
    activeAudio = audio;
    const finish = (s: PreviewStatus): void => {
      if (activeAudio === audio) activeAudio = null;
      if (my === token) {
        onStatus(s);
        currentListener = NOOP;
      }
      resolve();
    };
    audio.onplaying = () => {
      if (my === token) onStatus({ phase: 'playing' });
    };
    audio.onended = () => finish({ phase: 'idle' });
    audio.onerror = () => finish({ phase: 'idle', error: 'Could not load the preview clip' });
    audio.play().catch(() => finish({ phase: 'idle', error: 'Playback was blocked by the browser' }));
  });
}

/** Synthesise the preview sentence on device and play it (Kokoro / Supertonic). Never rejects. */
export function playSynthesized(
  config: EngineConfig,
  onStatus: StatusFn = NOOP,
  /** What to say — the sample sentence unless a caller (the pronunciation editor) has its own. */
  text: string = PREVIEW_SENTENCE,
): Promise<void> {
  const my = supersede();
  currentListener = onStatus;

  const key = configKey(config);
  const w = ensureWorker();

  return (async () => {
    try {
      if (warmKey !== key) {
        onStatus({ phase: 'loading', progress: 0, loadKind: 'compile' });
        const initId = nextId++;
        await new Promise<void>((res, rej) => {
          pending = {
            expectId: initId,
            onReady: (ep) => {
              warmEngineInfo = ep;
              res();
            },
            onError: rej,
            onProgress: ({ progress, phase }) => {
              if (my !== token) return;
              onStatus({
                phase: 'loading',
                progress,
                loadKind: phase === 'compile' ? 'compile' : 'download',
              });
            },
          };
          w.postMessage({ kind: 'init', id: initId, config });
        });
        // Only the preview that is still current may clear the shared callbacks: an older one
        // rejecting late used to wipe the *new* preview's, leaving it loading for ever.
        if (my !== token) return;
        pending = {};
        warmKey = key;
      }

      onStatus({ phase: 'synthesizing', engineInfo: warmEngineInfo });
      const synthId = nextId++;
      const { pcm, sampleRate } = await new Promise<{ pcm: Float32Array; sampleRate: number }>(
        (res, rej) => {
          pending = {
            expectId: synthId,
            onAudio: (p, sr) => res({ pcm: p, sampleRate: sr }),
            onError: rej,
          };
          w.postMessage({
            kind: 'synthesize',
            id: synthId,
            chunkIndex: 0,
            text,
            speed: config.speed,
            // Kokoro and Supertonic act on this: every voice previews without a re-init.
            voice: sharesModel(config.engine) ? config.voice : undefined,
          });
        },
      );
      if (my !== token) return;
      pending = {};

      onStatus({ phase: 'playing', engineInfo: warmEngineInfo });
      await playPcm(pcm, sampleRate, my);
      if (my === token) {
        onStatus({ phase: 'idle' });
        currentListener = NOOP;
      }
    } catch (err) {
      if (my !== token) return;
      pending = {};
      onStatus({ phase: 'idle', error: err instanceof Error ? err.message : String(err) });
      currentListener = NOOP;
    }
  })();
}

async function playPcm(pcm: Float32Array, sampleRate: number, my: number): Promise<void> {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
  if (sharedCtx.state === 'suspended') await sharedCtx.resume();
  if (my !== token) return;

  const buf = sharedCtx.createBuffer(1, Math.max(1, pcm.length), sampleRate);
  if (pcm.length) buf.copyToChannel(pcm, 0);
  const src = sharedCtx.createBufferSource();
  src.buffer = buf;
  src.connect(sharedCtx.destination);
  activeAudio = src;

  await new Promise<void>((resolve) => {
    src.onended = () => {
      if (activeAudio === src) activeAudio = null;
      resolve();
    };
    src.start();
  });
}
