/**
 * Downloading models from the options page, and showing how it is going.
 *
 * Two paths, because the two kinds of model are fetched by different code:
 *  - **Piper** is a pair of plain files, fetched straight through the model cache.
 *  - **Kokoro / Supertonic** are loaded by their engine (transformers.js and a hand-rolled ORT
 *    session respectively), so the only honest way to "download" one is to initialise it in a
 *    throwaway Worker and watch its progress events. That also warms the compile step, so the
 *    first real sentence is not the one paying for it.
 *
 * The options page is a normal extension page, so it may construct the Worker directly — unlike
 * a content script, which has to go through the synth-host iframe (see engine/worker-client.ts).
 */
import { browser } from 'wxt/browser';
import { asModelWriter, cacheHas, fetchModelFile } from '@/engine/model-cache';
import { KOKORO_VOICE_STORE, storeKokoroVoice } from '@/engine/kokoro-voice-files';
import { readCacheSizes, sharedModelInstalled } from '@/engine/installed-voices';
import { el } from '@/shared/dom';
import { humanBytes } from '@/shared/log';
import { KOKORO_VOICE_BYTES, kokoroVoiceUrl } from '@/shared/engine-catalog';
import type { EngineConfig, WorkerResponse } from '@/engine/protocol';
import type { PiperVoiceEntry } from '@/engine/engines/types';
import { downloads, type ProgressSink } from './download-queue';

/**
 * A slim progress bar with its share beside it, and a status line under it ("165 MB of 262 MB"),
 * shown inside a model row while it downloads. The share is said once, on the bar: the line and
 * the bar both said "15%" — the line twice.
 */
export class RowProgress {
  readonly wrap = el(document, 'div', { class: 'progress-wrap', hidden: '' });
  readonly msg = el(document, 'div', { class: 'progress-msg', hidden: '' });
  private readonly track = el(document, 'div', { class: 'progress-track' });
  private readonly fill = el(document, 'i');
  private readonly pct = el(document, 'span', { class: 'progress-pct' });

  constructor() {
    this.track.appendChild(this.fill);
    this.wrap.append(this.track, this.pct);
  }

  start(label: string): void {
    this.wrap.hidden = false;
    this.msg.hidden = false;
    this.msg.classList.remove('error');
    this.msg.textContent = label;
    this.set(0);
  }

  set(ratio: number): void {
    const share = Math.max(0, Math.min(1, ratio));
    this.fill.style.width = `${share * 100}%`;
    this.pct.textContent = `${Math.floor(share * 100)}%`;
  }

  note(text: string): void {
    this.msg.hidden = false;
    this.msg.classList.remove('error');
    this.msg.textContent = text;
  }

  /** Under way: the bar at `ratio`, and what is happening. */
  show(text: string, ratio: number): void {
    this.wrap.hidden = false;
    this.note(text);
    this.set(ratio);
  }

  /** In line behind another download: why it has not started, and a way to leave the line. */
  waiting(text: string, onCancel: () => void): void {
    this.wrap.hidden = true;
    this.note(text);
    this.msg.classList.add('is-waiting');
    const cancel = el(document, 'button', { type: 'button', class: 'link-btn' }, 'Cancel');
    cancel.addEventListener('click', onCancel);
    this.msg.append(' ', cancel);
  }

  fail(text: string): void {
    this.wrap.hidden = true;
    this.msg.hidden = false;
    this.msg.classList.add('error');
    this.msg.textContent = text;
  }

  done(): void {
    this.wrap.hidden = true;
    this.msg.hidden = true;
    this.msg.textContent = '';
    this.msg.classList.remove('is-waiting');
  }
}

/**
 * Tell every other open settings page that the model cache changed — a download finished or a
 * deletion ran — so none goes on showing a Download button for a voice that is there, or the
 * reverse. A page does not hear its own message.
 */
const modelsChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('aloud-models');

export function announceModelsChanged(): void {
  modelsChannel?.postMessage('changed');
}

export function onModelsChanged(fn: () => void): void {
  modelsChannel?.addEventListener('message', () => fn());
}

/**
 * The rows drawn now. Each redraw of the voice list starts a new scope and ends the last one, so
 * the rows it replaced stop listening to the queue at once. Waiting for a queue update to find
 * them detached left every row of every redraw subscribed while nothing was downloading: thirty
 * tab switches kept a thousand rows alive.
 */
let scope = new AbortController();

export function newDownloadScope(): void {
  scope.abort();
  scope = new AbortController();
}

/**
 * Keep a row's progress and its Download button in step with that download in the queue — the
 * row reads the queue rather than holding the state, so a redrawn list loses nothing. Stops
 * following once the row has left the page.
 */
export function followDownload(key: string, progress: RowProgress, button: HTMLButtonElement, idleLabel: string): () => void {
  let seen = false;
  let drawn: string | null = null;
  const render = (): void => {
    if (progress.msg.isConnected) seen = true;
    else if (seen) {
      stop();
      return;
    }
    const view = downloads.view(key);
    // Only when this row's own state changed. Every tick of the running download reaches every
    // row; redrawing a waiting row each time replaced its Cancel link many times a second.
    const state = view ? `${view.phase}|${view.text}|${view.phase === 'waiting' ? '' : Math.floor(view.ratio * 100)}` : 'idle';
    if (state === drawn) return;
    drawn = state;
    progress.msg.classList.remove('is-waiting');
    if (!view) {
      progress.done();
      button.disabled = false;
      button.textContent = idleLabel;
      return;
    }
    if (view.phase === 'failed') {
      progress.fail(view.text);
      button.disabled = false;
      button.textContent = idleLabel;
      return;
    }
    button.disabled = true;
    if (view.phase === 'waiting') {
      button.textContent = 'Queued';
      progress.waiting(view.text, () => downloads.cancel(key));
    } else if (view.phase === 'preparing') {
      button.textContent = 'Preparing…';
      progress.show(view.text, 1);
    } else {
      button.textContent = 'Downloading…';
      progress.show(view.text.replace(/^Downloading… \d+%( · )?/, '').replace(/ \d+%$/, '') || 'Downloading…', view.ratio);
    }
  };
  const stop = downloads.subscribe(render, scope.signal);
  render();
  // For a row replaced on its own, between whole-list redraws (a quality chip).
  return stop;
}

/**
 * The line of downloads at a glance, for the top of the voice section: what is downloading now,
 * and what is waiting behind it. Hidden while nothing is.
 */
export function downloadTray(): HTMLElement {
  const tray = el(document, 'div', { class: 'download-tray', role: 'status', 'aria-live': 'polite', hidden: '' });
  let seen = false;
  const render = (): void => {
    if (tray.isConnected) seen = true;
    else if (seen) {
      stop();
      return;
    }
    const [running, ...waiting] = downloads.all().filter((v) => v.phase !== 'failed');
    tray.hidden = !running;
    if (!running) return;
    const now =
      running.phase === 'preparing'
        ? `Preparing ${running.label}…`
        : `Downloading ${running.label} · ${Math.floor(running.ratio * 100)}%`;
    const then = waiting.length
      ? ` — then ${waiting.map((w) => w.label).join(', ')}. Downloads run one at a time.`
      : '';
    tray.textContent = now + then;
  };
  const stop = downloads.subscribe(render, scope.signal);
  render();
  return tray;
}

/** Fetch a Piper voice's weights and config, reporting their combined progress. */
export async function downloadPiperVoice(entry: PiperVoiceEntry, progress: ProgressSink): Promise<void> {
  // The two files stream in parallel, so progress has to be summed across both rather than
  // reported per file — otherwise the bar jumps backwards when the second one starts.
  const perFile = new Map<string, { loaded: number; total: number }>();
  const onProgress = (p: { file: string; loaded: number; total: number }): void => {
    perFile.set(p.file, { loaded: p.loaded, total: Math.max(p.total, p.loaded, 1) });
    let loaded = 0;
    let total = 0;
    for (const v of perFile.values()) {
      loaded += v.loaded;
      total += v.total;
    }
    // Against the voice's known size where the catalogue has it: the small config finishes
    // first, and measured on its own it read 100% before the voice itself had begun.
    total = Math.max(total, entry.sizeBytes ?? 0);
    progress.set(total > 0 ? loaded / total : 0);
    if (total > 0) progress.note(`${humanBytes(loaded)} of ${humanBytes(total)}`);
  };

  // Both files are this download's until both have stopped. With Promise.all, a failed config
  // ended the job while the voice file kept streaming: the queue moved on to the next voice, and
  // that orphan wrote its file after "Delete all downloads" had cleared everything. So the first
  // failure cancels the other, and the job ends only once both have settled.
  const stop = new AbortController();
  const fetchOne = (url: string, label: string, sha256?: string) =>
    fetchModelFile(url, { label, sha256, onProgress, signal: stop.signal, mustStore: true }).catch((err: unknown) => {
      stop.abort();
      throw err;
    });
  const results = await Promise.allSettled([
    fetchOne(entry.config, 'config', entry.sha256?.config),
    fetchOne(entry.onnx, 'voice', entry.sha256?.onnx),
  ]);
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  if (failures.length) {
    // The cause, not the cancellation it led to.
    const cause = failures.find((e) => !(e instanceof DOMException && e.name === 'AbortError')) ?? failures[0];
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
  // Both said they were stored; make sure the cache agrees before the row says "ready".
  const [config, voice] = await Promise.all([cacheHas(entry.config), cacheHas(entry.onnx)]);
  if (!config || !voice) throw new Error('The voice downloaded but could not be saved on this device — its storage may be full or blocked');
}

/** Which of `voices` have no file on this device yet. */
async function missingKokoroVoices(voices: readonly string[]): Promise<string[]> {
  if (typeof caches === 'undefined') return [];
  const store = await caches.open(KOKORO_VOICE_STORE);
  const missing: string[] = [];
  for (const voice of voices) if (!(await store.match(kokoroVoiceUrl(voice)))) missing.push(voice);
  return missing;
}

/** Fetch voices' files, checked, into kokoro-js's store, four at a time, reporting the bytes of each. */
async function fetchKokoroVoices(voices: readonly string[], onBytes: (bytes: number) => void): Promise<void> {
  const store = await caches.open(KOKORO_VOICE_STORE);
  let next = 0;
  const fetchNext = async (): Promise<void> => {
    while (next < voices.length) onBytes(await storeKokoroVoice(voices[next++]!, store));
  };
  await Promise.all(Array.from({ length: Math.min(4, voices.length) }, fetchNext));
}

/**
 * Download a shared model — for Kokoro, with every voice's own file alongside it, under one count.
 * Each Kokoro voice needs a small file of its own, which used to be fetched the first time that
 * voice spoke: every voice tried was another request after the "download" was done.
 */
export async function downloadSharedModel(config: EngineConfig, kokoroVoices: readonly string[], progress: ProgressSink): Promise<void> {
  const missing = config.engine === 'kokoro' ? await missingKokoroVoices(kokoroVoices) : [];
  if (!missing.length) return downloadViaWorker(config, progress);
  return downloadViaWorker(config, progress, {
    total: missing.length * KOKORO_VOICE_BYTES,
    start: (onBytes) => asModelWriter(() => fetchKokoroVoices(missing, onBytes)),
  });
}

/** Files fetched alongside a model, counted in its progress and finished before it is ready. */
interface Alongside {
  total: number;
  start: (onBytes: (bytes: number) => void) => Promise<void>;
}

/**
 * Download a shared model by initialising it once in a throwaway Worker.
 *
 * Resolves when the engine reports `ready` (downloaded, verified and compiled) and anything
 * `alongside` has arrived; rejects on the first fatal error. The Worker is always terminated,
 * including on the error path.
 */
export function downloadViaWorker(config: EngineConfig, progress: ProgressSink, alongside?: Alongside): Promise<void> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(browser.runtime.getURL('/tts-worker.js'), {
        type: 'module',
        name: 'aloud-model-download',
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        worker.postMessage({ kind: 'dispose', id: 99 });
        worker.terminate();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve();
    };

    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      finish(new Error(ev.message || ev.error?.message || 'worker crashed while downloading'));
    };
    worker.onmessageerror = () => finish(new Error('worker sent an unreadable message'));
    // One count for what is really downloading: the model's files fetched over the network (the
    // worker leaves out those already on the device, and sums the rest), and what comes alongside.
    const model = { loaded: 0, total: 0 };
    let compiled = false;
    let alongLoaded = 0;
    let alongDone = !alongside;
    const report = (): void => {
      if (compiled && alongDone) {
        progress.set(1);
        progress.note('Downloaded — preparing the model…');
        return;
      }
      const loaded = (compiled ? model.total : model.loaded) + alongLoaded;
      const total = model.total + (alongside?.total ?? 0);
      progress.set(total > 0 ? Math.min(1, loaded / total) : 0);
      // The share is on the bar; the line under it says how much.
      progress.note(total > 0 ? `${humanBytes(loaded)} of ${humanBytes(total)}` : 'Downloading…');
    };
    const along = alongside?.start((bytes) => {
      alongLoaded += bytes;
      report();
    });
    along?.then(
      () => {
        alongDone = true;
        report();
      },
      (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
    );

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'model-progress') {
        if (m.phase === 'compile') compiled = true;
        else {
          model.loaded = m.freshLoaded ?? m.loaded;
          model.total = m.freshTotal ?? m.total;
        }
        report();
      } else if (m.kind === 'ready') {
        // Ready means the engine loaded — from memory if need be. A Download is for offline use,
        // so it is done only once the model is really in the cache, with its voices.
        void (along ?? Promise.resolve())
          .then(() => readCacheSizes())
          .then((sizes) =>
            finish(
              sharedModelInstalled(config.engine, sizes)
                ? undefined
                : new Error('The model downloaded but could not be saved on this device — its storage may be full or blocked'),
            ),
          )
          .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
      } else if (m.kind === 'error' && m.fatal) {
        finish(new Error(m.phase ? `[${m.phase}] ${m.message}` : m.message));
      }
    };

    worker.postMessage({ kind: 'init', id: 1, config });
  });
}
