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
import { fetchModelFile } from '@/engine/model-cache';
import { el } from '@/shared/dom';
import type { EngineConfig, WorkerResponse } from '@/engine/protocol';
import type { PiperVoiceEntry } from '@/engine/engines/types';
import { downloads, type ProgressSink } from './download-queue';

/** A slim progress bar plus a status line, shown inside a model row while it downloads. */
export class RowProgress {
  readonly wrap = el(document, 'div', { class: 'progress-wrap', hidden: '' });
  readonly msg = el(document, 'div', { class: 'progress-msg', hidden: '' });
  private readonly fill = el(document, 'i');

  constructor() {
    this.wrap.appendChild(this.fill);
  }

  start(label: string): void {
    this.wrap.hidden = false;
    this.msg.hidden = false;
    this.msg.classList.remove('error');
    this.msg.textContent = label;
    this.set(0);
  }

  set(ratio: number): void {
    this.fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
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
 * Keep a row's progress and its Download button in step with that download in the queue — the
 * row reads the queue rather than holding the state, so a redrawn list loses nothing. Stops
 * following once the row has left the page.
 */
export function followDownload(key: string, progress: RowProgress, button: HTMLButtonElement, idleLabel: string): void {
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
      progress.show(`${view.text.replace(/ \d+%$/, '')} ${Math.floor(view.ratio * 100)}%`, view.ratio);
    }
  };
  const stop = downloads.subscribe(render);
  render();
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
  const stop = downloads.subscribe(render);
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
  };

  await Promise.all([
    fetchModelFile(entry.config, { label: 'config', sha256: entry.sha256?.config, onProgress }),
    fetchModelFile(entry.onnx, { label: 'voice', sha256: entry.sha256?.onnx, onProgress }),
  ]);
}

/**
 * Download a shared model by initialising it once in a throwaway Worker.
 *
 * Resolves when the engine reports `ready` (downloaded, verified and compiled), rejects on the
 * first fatal error. The Worker is always terminated, including on the error path.
 */
export function downloadViaWorker(config: EngineConfig, progress: ProgressSink): Promise<void> {
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
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'model-progress') {
        if (m.phase === 'compile') {
          progress.set(1);
          progress.note('Downloaded — preparing the model…');
        } else {
          const ratio = m.total > 0 ? m.loaded / m.total : 0;
          progress.set(ratio);
          progress.note(`Downloading… ${Math.floor(ratio * 100)}%`);
        }
      } else if (m.kind === 'ready') {
        finish();
      } else if (m.kind === 'error' && m.fatal) {
        finish(new Error(m.phase ? `[${m.phase}] ${m.message}` : m.message));
      }
    };

    worker.postMessage({ kind: 'init', id: 1, config });
  });
}
