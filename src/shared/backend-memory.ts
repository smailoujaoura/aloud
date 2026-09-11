/**
 * Remembers which execution path synthesis took last time on this device.
 *
 * The content script has to chop the article into chunks *before* the engine has loaded, and the
 * right chunk size depends on where synthesis will run: bigger chunks amortise per-inference
 * overhead on a GPU, smaller ones keep a CPU from disappearing for ten seconds mid-paragraph.
 * The honest answer only arrives with `ready`, which is too late for a decision already made.
 *
 * So the last observed answer is remembered here. It is a hint, never a promise: the first
 * session on a machine plans for the CPU (the safe way to be wrong), and every session still
 * re-tunes its queue depth the moment the worker reports its real provider.
 */
import { storage } from 'wxt/utils/storage';

export type RememberedBackend = 'gpu' | 'cpu';

const item = storage.defineItem<RememberedBackend | null>('local:lastSynthBackend', {
  fallback: null,
});

/** The last observed backend, or `null` when synthesis has never run on this device. */
export async function loadLastBackend(): Promise<RememberedBackend | null> {
  try {
    return await item.getValue();
  } catch {
    // Storage is unavailable in some contexts (and can fail in private windows); a missing hint
    // is not worth failing a read for.
    return null;
  }
}

/** Record the backend the engine actually used. Cheap no-op when nothing changed. */
export async function saveLastBackend(backend: RememberedBackend): Promise<void> {
  try {
    if ((await item.getValue()) === backend) return;
    await item.setValue(backend);
  } catch {
    /* remembering is best-effort */
  }
}

/**
 * Whether a synthesis *worker* on this device was granted WebGPU, the last time one was asked.
 *
 * Only a worker can answer that (Firefox gates documents and workers with different prefs), and
 * spawning one costs a moment — so the answer is remembered here for every page that needs to
 * describe the machine without measuring it again: the walkthrough's engine cards, the engine
 * standings, the settings page's first paint before its own live check comes back.
 */
const workerGpuItem = storage.defineItem<boolean | null>('local:workerWebGPU', { fallback: null });

/** The last worker-side WebGPU answer, or `null` if none has ever been taken here. */
export async function loadWorkerGpu(): Promise<boolean | null> {
  try {
    return await workerGpuItem.getValue();
  } catch {
    return null;
  }
}

export async function saveWorkerGpu(available: boolean): Promise<void> {
  try {
    if ((await workerGpuItem.getValue()) === available) return;
    await workerGpuItem.setValue(available);
  } catch {
    /* remembering is best-effort */
  }
}
