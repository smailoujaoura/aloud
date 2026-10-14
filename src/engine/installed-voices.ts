/**
 * "What is actually downloaded?" — reading the model cache to decide what the options page can
 * offer right now.
 *
 * The cache is keyed by download URL, so presence is answered by looking for the right keys:
 * Piper needs both files of a specific voice, while Kokoro and Supertonic each have one shared
 * model whose presence unlocks every voice they define.
 */
import { cacheEntries } from '@/engine/model-cache';
import { engineInfo } from '@/shared/engine-catalog';
import type { EngineId } from '@/shared/settings';
import { listVoices, type VoiceOption } from '@/shared/voice-catalog';
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';

/** Cache key (download URL) -> stored size in bytes. */
export type CacheSizes = Map<string, number>;

export async function readCacheSizes(): Promise<CacheSizes> {
  const entries = await cacheEntries();
  const sizes: CacheSizes = new Map(entries.map((e) => [e.key, e.size]));
  // Kokoro's per-voice files are the one thing not in Aloud's own store: kokoro-js keeps them in
  // Cache Storage. Without them here, a voice never used looked ready to read offline.
  try {
    const cache = await caches.open('kokoro-voices');
    for (const request of await cache.keys()) {
      if (sizes.has(request.url)) continue;
      // Their real size, so "on this device" counts them: they are part of Kokoro's download.
      const declared = Number((await cache.match(request))?.headers.get('content-length'));
      sizes.set(request.url, Number.isFinite(declared) && declared > 0 ? declared : 1);
    }
  } catch {
    /* no Cache Storage in this context */
  }
  return sizes;
}

/**
 * What is known about the machine, for questions whose answer depends on it.
 *
 * `gpu`: whether the synthesis worker last reached a GPU (null: not known). `online`: whether a
 * missing small file can simply be fetched — a voice's own file is a few hundred kilobytes, so
 * online every voice of an installed model is usable; offline only the ones already fetched.
 */
/**
 * Will reading use the GPU? Only where the settings ask for it *and* the worker has one: a machine
 * with a GPU, set to read on the CPU, needs the CPU weights — and was told it had no voices offline,
 * because its GPU weights were missing. Null when it cannot be known.
 */
export function readingOnGpu(preferWebGPU: boolean | undefined, workerGpu: boolean | null): boolean | null {
  if (preferWebGPU === false) return false;
  return workerGpu;
}

export interface Availability {
  gpu?: boolean | null;
  online?: boolean;
}

/** Total bytes held for a shared model, identified by a substring of its download URLs. */
export function sharedModelBytes(sizes: CacheSizes, cacheHint: string): number {
  let total = 0;
  for (const [key, size] of sizes) if (key.includes(cacheHint)) total += size;
  return total;
}

/** A Piper voice is usable only when both its weights and its config are present. */
export function piperDownloaded(entry: PiperVoiceEntry, sizes: CacheSizes): boolean {
  return sizes.get(entry.config) != null && sizes.get(entry.onnx) != null;
}

/** Bytes on disk for one Piper voice. */
export function piperVoiceBytes(entry: PiperVoiceEntry, sizes: CacheSizes): number {
  return (sizes.get(entry.config) ?? 0) + (sizes.get(entry.onnx) ?? 0);
}

/** True when the engine's model is present and its voices can be selected. */
export function engineDownloaded(engine: EngineId, manifest: ModelManifest, sizes: CacheSizes): boolean {
  const hint = engineInfo(engine).cacheHint;
  if (!hint) return Object.values(manifest.piper).some((v) => piperDownloaded(v, sizes));
  return sharedModelInstalled(engine, sizes);
}

/**
 * Is Kokoro's or Supertonic's model — every file it loads, not just some of them — on this device?
 *
 * With `gpu` known, the weights for that path are required; unknown, either set will do.
 */
export function sharedModelInstalled(engine: EngineId, sizes: CacheSizes, where: Availability = {}): boolean {
  const { cacheHint: hint, requiredFiles = [], weights } = engineInfo(engine);
  if (!hint) return false;
  if (!requiredFiles.length && !weights) return sharedModelBytes(sizes, hint) > 0;
  const { revision } = engineInfo(engine);
  const has = (file: string): boolean => cached(sizes, hint, file, revision);
  // All of them: some bytes in the cache is not the same as a model that can speak.
  if (!requiredFiles.every(has)) return false;
  if (!weights) return true;
  if (where.gpu === true) return has(weights.gpu);
  if (where.gpu === false) return has(weights.cpu);
  return has(weights.cpu) || has(weights.gpu);
}

/** A file of the model `hint`, present with something in it. */
/** A file of the model `hint` — from `revision`, when given — present with something in it. */
function cached(sizes: CacheSizes, hint: string, file: string, revision?: string): boolean {
  const at = revision ? `/resolve/${revision}/` : null;
  for (const [key, size] of sizes) {
    if (size > 0 && key.includes(hint) && key.endsWith(file) && (!at || key.includes(at))) return true;
  }
  return false;
}

/**
 * Voices that can be used *right now*, for the top-of-page picker.
 *
 * Piper is filtered to downloaded voices; the shared-model engines are all-or-nothing.
 */
export function usableVoices(
  engine: EngineId,
  manifest: ModelManifest,
  sizes: CacheSizes,
  where: Availability = {},
): VoiceOption[] {
  if (engine === 'piper') {
    return listVoices('piper', manifest).filter((v) => {
      const entry = manifest.piper[v.id];
      return entry ? piperDownloaded(entry, sizes) : false;
    });
  }
  if (!sharedModelInstalled(engine, sizes, where)) return [];
  const voices = listVoices(engine, manifest);
  const { cacheHint, voiceFile, revision, voiceRevision } = engineInfo(engine);
  // Offline, a voice whose own file was never fetched cannot start.
  if (where.online !== false || !voiceFile || !cacheHint) return voices;
  return voices.filter((v) => cached(sizes, cacheHint, voiceFile(v.id), voiceRevision ?? revision));
}
