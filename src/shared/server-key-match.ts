/**
 * Which server a stored key belongs to (shared/server-key.ts). Free of extension APIs, so the
 * synthesis host, built on its own, can use it too (synth-host/entry.ts).
 */

export interface StoredServerKey {
  /** `https://host:port` of the server the key was given for. */
  origin: string;
  key: string;
}

/** `https://host:port` of a server address, or '' when it is not one. */
export function serverKeyOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** The key stored for this server address, if `stored` is one and was given for it. */
export function keyFor(stored: unknown, url: string): string {
  const s = stored as Partial<StoredServerKey> | null;
  const origin = serverKeyOrigin(url);
  return s && typeof s.key === 'string' && s.key && origin && s.origin === origin ? s.key : '';
}
