/**
 * Kokoro's voice files, fetched and checked by Aloud rather than by kokoro-js.
 *
 * Each voice is a small file of style vectors (522,240 bytes) that kokoro-js reads as numbers and
 * feeds to the model. Left to itself, kokoro-js fetches it from the repository's moving `main`
 * branch, unchecked, the first time a voice speaks. Here it comes from the pinned revision, is
 * checked against its published SHA-256, and is put where kokoro-js looks for it — so kokoro-js
 * always finds it and never fetches one itself.
 */
import { KOKORO_REVISION, KOKORO_VOICE_BYTES, kokoroVoiceUrl } from '@/shared/engine-catalog';
import { KOKORO_VOICE_SHA256 } from '@/shared/kokoro-voice-pins';
import { sha256Hex } from './model-cache';

/** The Cache Storage store kokoro-js keeps voices in. */
export const KOKORO_VOICE_STORE = 'kokoro-voices';

/** Where a voice is downloaded from: the commit the model is pinned to. */
export const kokoroVoiceSource = (voice: string): string =>
  `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_REVISION}/voices/${voice}.bin`;

/** A voice Aloud can check, and so will let kokoro-js read. */
export const hasKokoroVoicePin = (voice: string): boolean => Object.hasOwn(KOKORO_VOICE_SHA256, voice);

async function genuine(voice: string, bytes: ArrayBuffer): Promise<boolean> {
  return bytes.byteLength === KOKORO_VOICE_BYTES && (await sha256Hex(bytes)) === KOKORO_VOICE_SHA256[voice];
}

/**
 * A connection that stops delivering is dropped and tried again, rather than leaving the whole
 * download waiting on it for ever. Stopped means no data for this long — not slow: on a slow line
 * half a megabyte can take a minute and still be arriving.
 */
const STALL_MS = 120_000;
const ATTEMPTS = 3;

async function fetchWithRetry(url: string, voice: string, cancel?: AbortSignal): Promise<ArrayBuffer> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    cancel?.throwIfAborted();
    const stop = new AbortController();
    // Cancelled from outside (the download it belongs to failed): stop now, and do not retry.
    const cancelled = (): void => stop.abort();
    cancel?.addEventListener('abort', cancelled, { once: true });
    let timer = setTimeout(() => stop.abort(), STALL_MS);
    const arrived = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => stop.abort(), STALL_MS);
    };
    try {
      const res = await fetch(url, { credentials: 'omit', signal: stop.signal });
      if (!res.ok) throw new Error(`Download failed (${res.status}) for the voice ${voice}`);
      if (!res.body) return await res.arrayBuffer();
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.byteLength;
        arrived();
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.byteLength;
      }
      return bytes.buffer;
    } catch (err) {
      cancel?.throwIfAborted();
      last = stop.signal.aborted ? new Error(`The voice ${voice} did not download — the connection kept stalling`) : err;
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', cancelled);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Download `voice`'s file, check it, and store it where kokoro-js reads it. Returns its size. */
export async function storeKokoroVoice(voice: string, store?: Cache, cancel?: AbortSignal): Promise<number> {
  if (!hasKokoroVoicePin(voice)) throw new Error(`The Kokoro voice ${voice} cannot be checked, so it is not downloaded`);
  const bytes = await fetchWithRetry(kokoroVoiceSource(voice), voice, cancel);
  if (!(await genuine(voice, bytes))) throw new Error(`Integrity check failed for the voice ${voice}`);
  const target = store ?? (await caches.open(KOKORO_VOICE_STORE));
  // Nothing is written once the download it belongs to has failed.
  cancel?.throwIfAborted();
  await target.put(
    kokoroVoiceUrl(voice),
    new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) } }),
  );
  return bytes.byteLength;
}

const checked = new Set<string>();

/**
 * Before kokoro-js reads `voice`: its file is in the store and is the published one. A file that
 * is missing — or one kokoro-js fetched itself, unchecked, under an earlier version — is replaced.
 * Checked once per worker; a voice's file is read once per worker too.
 */
export async function ensureKokoroVoice(voice: string): Promise<void> {
  if (checked.has(voice) || typeof caches === 'undefined') return;
  const store = await caches.open(KOKORO_VOICE_STORE);
  const held = await store.match(kokoroVoiceUrl(voice));
  if (!held || !(await genuine(voice, await held.arrayBuffer()))) await storeKokoroVoice(voice, store);
  checked.add(voice);
}
