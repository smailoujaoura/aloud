/**
 * "Can Aloud's synthesis worker reach the GPU on this machine?" — asked of a real worker.
 *
 * The options page can probe `navigator.gpu` itself, but its answer is about the *page*. Firefox
 * gates the two contexts separately (`dom.webgpu.enabled` for documents,
 * `dom.webgpu.workers.enabled` for workers), so a page with WebGPU can host workers without it —
 * and it is the worker that runs inference. Chromium can disagree the other way round, granting
 * an adapter to neither.
 *
 * So the page spawns one throwaway worker, asks it, and terminates it. No model is loaded and
 * nothing is downloaded; the whole thing is a `requestAdapter()` call in the right context.
 */
import { browser } from 'wxt/browser';
import type { WorkerResponse } from '@/engine/protocol';
import { saveWorkerGpu } from '@/shared/backend-memory';

export interface WorkerGpuResult {
  webgpu: boolean;
  adapterInfo?: string;
  shaderF16?: boolean;
  detail: string;
}

/** How long to wait for the worker to answer before treating the answer as "no". */
const TIMEOUT_MS = 8000;

export function probeWorkerGpu(): Promise<WorkerGpuResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(browser.runtime.getURL('/tts-worker.js'), {
        type: 'module',
        name: 'aloud-gpu-probe',
      });
    } catch (err) {
      resolve({ webgpu: false, detail: `The synthesis worker could not start (${String(err)}).` });
      return;
    }

    let settled = false;
    const finish = (result: WorkerGpuResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      // Remembered so every other page — the walkthrough's engine cards, the engine standings —
      // can describe this machine without spawning a worker of its own.
      void saveWorkerGpu(result.webgpu);
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ webgpu: false, detail: 'The synthesis worker did not answer in time.' }),
      TIMEOUT_MS,
    );

    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      finish({ webgpu: false, detail: `The synthesis worker failed to start (${ev.message}).` });
    };
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (!m || m.kind !== 'gpu-probe') return;
      finish({ webgpu: m.webgpu, adapterInfo: m.adapterInfo, shaderF16: m.shaderF16, detail: m.detail });
    };

    worker.postMessage({ kind: 'probe-gpu', id: 1 });
  });
}
