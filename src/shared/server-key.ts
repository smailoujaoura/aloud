/**
 * The key for the reader's own speech server, when it asks for one (a server reached over the
 * internet, behind a reverse proxy that checks `Authorization: Bearer …`).
 *
 * Kept on its own in `storage.local` (`serverKey`), not in the settings: settings travel in
 * backups, and are read by the reader inside web pages. The key is read only by extension pages
 * (Settings, and the synthesis host that starts the workers) and sent only to the server.
 *
 * Kept with the server it was given for (scheme, host and port), and handed out for that server
 * only: whatever changes the address (Settings, a restored backup), another server never gets it.
 */
import { storage } from 'wxt/utils/storage';
import type { EngineConfig } from '@/engine/protocol';
import { keyFor, serverKeyOrigin, type StoredServerKey } from './server-key-match';

export { keyFor, serverKeyOrigin, type StoredServerKey };

/** The storage.local key; the synthesis host reads it by this name (synth-host/entry.ts). */
export const SERVER_KEY_STORAGE = 'serverKey';

const item = storage.defineItem<StoredServerKey | null>(`local:${SERVER_KEY_STORAGE}`, { fallback: null });

/** The key for the server at `url`, or '' when there is none for that server. */
export async function getServerKey(url: string): Promise<string> {
  try {
    return keyFor(await item.getValue(), url);
  } catch {
    return '';
  }
}

/** Keep `key` for the server at `url`; empty removes any key. */
export async function setServerKey(key: string, url = ''): Promise<void> {
  const k = key.trim();
  const origin = serverKeyOrigin(url);
  if (k && origin) await item.setValue({ origin, key: k });
  else await item.removeValue();
}

/** `config` with its server's key, for an engine config started from an extension page. */
export async function withServerKey(config: EngineConfig): Promise<EngineConfig> {
  if (config.engine !== 'server' || !config.server) return config;
  const key = await getServerKey(config.server.url);
  return key ? { ...config, server: { ...config.server, key } } : config;
}
