/**
 * Model file cache — a single IndexedDB store at the extension origin, shared by every tab's
 * worker. Used directly by the Piper path and, via the `TransformersCache` adapter, by the
 * Kokoro path (`@huggingface/transformers`'s `env.customCache`).
 *
 * Downloads run under a `navigator.locks` lock keyed by URL so two tabs opening at once fetch
 * an 80 MB model only once.
 */

const DB_NAME = 'aloud-models';
const STORE = 'files';
/**
 * v2 adds an index over [size, storedAt]. Listing what is cached used to call `getAll()`, which
 * deserialises every record — and each record holds a whole model. Asking "which voices are on
 * this device?" therefore pulled hundreds of megabytes into memory, on a page that only wanted
 * names and sizes. A key cursor over the index answers from the index alone: the model bytes are
 * never read.
 */
const DB_VERSION = 2;
const META_INDEX = 'meta';

interface FileRecord {
  key: string;
  buf: ArrayBuffer;
  size: number;
  contentType: string;
  storedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new Error('IndexedDB is not available in this context'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Firefox throws here outright when storage is disabled / in some private windows.
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' }).createIndex(META_INDEX, ['size', 'storedAt']);
      } else if (req.transaction) {
        const store = req.transaction.objectStore(STORE);
        if (!store.indexNames.contains(META_INDEX)) store.createIndex(META_INDEX, ['size', 'storedAt']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked (another tab holds an older version)'));
  }).catch((err) => {
    // Don't cache a permanently-rejected promise — allow a later call to retry.
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let t: IDBTransaction;
        try {
          t = db.transaction(STORE, mode);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        // Without these a quota abort or a connection error leaves the promise pending forever,
        // which reads to the caller as a silent hang rather than a failure.
        t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
        t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction error'));
        const store = t.objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export async function cacheGet(key: string): Promise<FileRecord | undefined> {
  try {
    return (await tx<FileRecord | undefined>('readonly', (s) => s.get(key) as IDBRequest<FileRecord | undefined>)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function cachePut(key: string, buf: ArrayBuffer, contentType: string): Promise<void> {
  const rec: FileRecord = { key, buf, size: buf.byteLength, contentType, storedAt: Date.now() };
  try {
    await tx('readwrite', (s) => s.put(rec));
  } catch (err) {
    // QuotaExceededError etc. — try evicting the oldest entry once, then give up quietly.
    try {
      const keys = await cacheEntries();
      const oldest = keys.sort((a, b) => a.storedAt - b.storedAt)[0];
      if (oldest && oldest.key !== key) {
        await cacheDelete(oldest.key);
        await tx('readwrite', (s) => s.put(rec));
        return;
      }
    } catch {
      /* noop */
    }
    console.warn('[aloud] model cache put failed:', err);
  }
}

export async function cacheDelete(key: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(key));
}

export async function cacheEntries(): Promise<Array<{ key: string; size: number; storedAt: number }>> {
  try {
    return await new Promise((resolve, reject) => {
      void openDb().then((db) => {
        const store = db.transaction(STORE, 'readonly').objectStore(STORE);
        // The index holds [size, storedAt] and the cursor also carries the primary key (the url),
        // so everything this returns comes from the index — no model buffer is ever deserialised.
        const req = store.index(META_INDEX).openKeyCursor();
        const out: Array<{ key: string; size: number; storedAt: number }> = [];
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(out);
            return;
          }
          const [size, storedAt] = cursor.key as [number, number];
          out.push({ key: String(cursor.primaryKey), size, storedAt });
          cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error('cacheEntries failed'));
      }, reject);
    });
  } catch {
    return [];
  }
}

/**
 * Cache API stores written by our dependencies rather than by us.
 *
 * `kokoro-js` fetches its per-voice `.bin` style vectors itself through `caches.open(
 * 'kokoro-voices')`, bypassing `env.customCache` entirely, and `@huggingface/transformers` falls
 * back to `transformers-cache` if the custom cache is ever not in force. Both are invisible to
 * the IndexedDB store, so unless they are cleared alongside it "Delete" leaves files on disk and
 * the reported usage is wrong.
 */
const EXTERNAL_CACHE_STORES = ['kokoro-voices', 'transformers-cache'] as const;

/** Cache API stores that hold files for a given engine, keyed by the engine's cache hint. */
const EXTERNAL_STORES_BY_MODEL: Record<string, readonly string[]> = {
  'Kokoro-82M': ['kokoro-voices', 'transformers-cache'],
};

async function deleteCacheStores(names: readonly string[]): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(
    names.map(async (name) => {
      try {
        await caches.delete(name);
      } catch {
        /* storage disabled, or the store never existed */
      }
    }),
  );
}

async function cacheStoreBytes(names: readonly string[]): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  let total = 0;
  for (const name of names) {
    try {
      if (!(await caches.has(name))) continue;
      const store = await caches.open(name);
      for (const request of await store.keys()) {
        const res = await store.match(request);
        if (!res) continue;
        const declared = Number(res.headers.get('content-length'));
        total += Number.isFinite(declared) && declared > 0 ? declared : (await res.blob()).size;
      }
    } catch {
      /* unreadable store — leave it out of the total rather than failing the page */
    }
  }
  return total;
}

/**
 * Delete cached model files. With no argument, everything — including the Cache API stores our
 * dependencies write to. With a `prefix`, only the IndexedDB entries whose key contains it, plus
 * any external store belonging to that model.
 */
export async function cacheClear(prefix?: string): Promise<void> {
  const entries = await cacheEntries();
  await Promise.all(
    entries.filter((e) => !prefix || e.key.includes(prefix)).map((e) => cacheDelete(e.key)),
  );
  await deleteCacheStores(prefix ? (EXTERNAL_STORES_BY_MODEL[prefix] ?? []) : EXTERNAL_CACHE_STORES);
}

/** Total bytes held on this device, across both our store and our dependencies'. */
export async function cacheUsageBytes(): Promise<number> {
  const entries = await cacheEntries();
  const ours = entries.reduce((sum, e) => sum + e.size, 0);
  return ours + (await cacheStoreBytes(EXTERNAL_CACHE_STORES));
}

/** True in private windows where IndexedDB writes silently fail / are wiped. */
export async function isPersistent(): Promise<boolean> {
  try {
    const probeKey = '__aloud_probe__';
    await cachePut(probeKey, new Uint8Array([1]).buffer, 'application/octet-stream');
    const got = await cacheGet(probeKey);
    await cacheDelete(probeKey);
    return !!got;
  } catch {
    return false;
  }
}

export interface DownloadProgress {
  file: string;
  loaded: number;
  total: number;
  phase: 'download' | 'cache';
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch `url`, returning its bytes. Served from IndexedDB when present; otherwise downloaded
 * (with streaming progress), optionally SHA-256 verified, and cached.
 */
export async function fetchModelFile(
  url: string,
  opts: { sha256?: string; onProgress?: (p: DownloadProgress) => void; label?: string } = {},
): Promise<Uint8Array> {
  const label = opts.label ?? url.split('/').pop() ?? url;

  const cached = await cacheGet(url);
  if (cached) {
    opts.onProgress?.({ file: label, loaded: cached.size, total: cached.size, phase: 'download' });
    return new Uint8Array(cached.buf);
  }

  return navigator.locks.request(`aloud-dl:${url}`, async () => {
    const again = await cacheGet(url);
    if (again) return new Uint8Array(again.buf);

    const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);

    const total = Number(res.headers.get('content-length')) || 0;
    const contentType = res.headers.get('content-type') || 'application/octet-stream';

    let bytes: Uint8Array;
    if (res.body) {
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        loaded += value.byteLength;
        opts.onProgress?.({ file: label, loaded, total: total || loaded, phase: 'download' });
      }
      bytes = new Uint8Array(loaded);
      let off = 0;
      for (const p of parts) {
        bytes.set(p, off);
        off += p.byteLength;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
      opts.onProgress?.({ file: label, loaded: bytes.byteLength, total: bytes.byteLength, phase: 'download' });
    }

    if (opts.sha256) {
      const actual = await sha256Hex(bytes.buffer);
      if (actual.toLowerCase() !== opts.sha256.toLowerCase()) {
        throw new Error(`Integrity check failed for ${label}: expected ${opts.sha256}, got ${actual}`);
      }
    }

    opts.onProgress?.({ file: label, loaded: bytes.byteLength, total: bytes.byteLength, phase: 'cache' });
    await cachePut(url, bytes.buffer.slice(0), contentType);
    return bytes;
  });
}

/**
 * A Web Cache API-compatible object (`match`/`put`) backed by our IndexedDB store, for
 * `@huggingface/transformers`'s `env.customCache`.
 */
/** Whether `key` is in the cache, without reading its bytes. */
export async function cacheHas(key: string): Promise<boolean> {
  try {
    return (await tx<number>('readonly', (s) => s.count(key))) > 0;
  } catch {
    return false;
  }
}

/**
 * A chance to rewrite a file as transformers.js reads it from the cache — used to expose the
 * Kokoro model's phoneme durations as an extra output (see engines/kokoro.ts). Returns the bytes
 * to serve, or null to serve the file as stored.
 */
export type CachedFileTransform = (key: string, bytes: Uint8Array) => Uint8Array | null;
let transform: CachedFileTransform | null = null;

export function setCachedFileTransform(fn: CachedFileTransform | null): void {
  transform = fn;
}

export const TransformersCache = {
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request.toString();
    const rec = await cacheGet(key);
    if (!rec) return undefined;
    const rewritten = transform?.(key, new Uint8Array(rec.buf)) ?? null;
    const body = rewritten ?? rec.buf;
    const size = rewritten ? rewritten.byteLength : rec.size;
    return new Response(body as BodyInit, {
      headers: {
        'Content-Type': rec.contentType,
        'Content-Length': String(size),
      },
    });
  },

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key = typeof request === 'string' ? request : request.toString();
    const buf = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    await cachePut(key, buf, contentType);
  },
};
