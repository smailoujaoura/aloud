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
  return new Map(entries.map((e) => [e.key, e.size]));
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
  return sharedModelBytes(sizes, hint) > 0;
}

/**
 * Which Kokoro weights are actually on disk, or null if none are.
 *
 * Kokoro ships several precisions of the same model as differently-named files in one repo, and
 * the panel's single Download/Delete button reports on the repo as a whole. Without this the UI
 * says "downloaded" while the precision the reader selected is still missing, and pressing
 * Download appears to do nothing.
 */
export function kokoroInstalledPrecision(sizes: CacheSizes): 'q8' | 'fp32' | null {
  let quantised = false;
  let full = false;
  for (const key of sizes.keys()) {
    if (!key.includes('Kokoro-82M')) continue;
    if (/model_quantized\.onnx$/.test(key)) quantised = true;
    else if (/\/model\.onnx$/.test(key)) full = true;
  }
  // Prefer reporting full precision when both are present: it is what reading will pick up.
  if (full) return 'fp32';
  return quantised ? 'q8' : null;
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
): VoiceOption[] {
  if (engine === 'piper') {
    return listVoices('piper', manifest).filter((v) => {
      const entry = manifest.piper[v.id];
      return entry ? piperDownloaded(entry, sizes) : false;
    });
  }
  const hint = engineInfo(engine).cacheHint;
  if (!hint || sharedModelBytes(sizes, hint) === 0) return [];
  return listVoices(engine, manifest);
}
