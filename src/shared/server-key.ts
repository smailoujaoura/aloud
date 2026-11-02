/**
 * The key for the reader's own speech server, when it asks for one (a server reached over the
 * internet, behind a reverse proxy that checks `Authorization: Bearer …`).
 *
 * Kept on its own in `storage.local` (`serverKey`), not in the settings: settings travel in
 * backups, and are read by the reader inside web pages. The key is read only by extension pages
 * (Settings, and the synthesis host that starts the workers) and sent only to the server.
 */
import { storage } from 'wxt/utils/storage';
import type { EngineConfig } from '@/engine/protocol';

/** The storage.local key; the synthesis host reads it by this name (synth-host/entry.ts). */
export const SERVER_KEY_STORAGE = 'serverKey';

const item = storage.defineItem<string>(`local:${SERVER_KEY_STORAGE}`, { fallback: '' });

export async function getServerKey(): Promise<string> {
  try {
    const key = await item.getValue();
    return typeof key === 'string' ? key : '';
  } catch {
    return '';
  }
}

/** Empty removes it. */
export async function setServerKey(key: string): Promise<void> {
  const k = key.trim();
  if (k) await item.setValue(k);
  else await item.removeValue();
}

/** `config` with the server's key, for an engine config started from an extension page. */
export async function withServerKey(config: EngineConfig): Promise<EngineConfig> {
  if (config.engine !== 'server' || !config.server) return config;
  const key = await getServerKey();
  return key ? { ...config, server: { ...config.server, key } } : config;
}
