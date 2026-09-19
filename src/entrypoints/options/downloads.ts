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
    this.msg.textContent = text;
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
  }
}

/** Fetch a Piper voice's weights and config, reporting their combined progress. */
export async function downloadPiperVoice(entry: PiperVoiceEntry, progress: RowProgress): Promise<void> {
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
export function downloadViaWorker(config: EngineConfig, progress: RowProgress): Promise<void> {
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
