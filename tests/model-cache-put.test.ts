import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The smallest IndexedDB the model cache needs: one object store with a [size, storedAt] index,
 * whose writes can be made to fail as a full disk does (the transaction aborts with
 * QuotaExceededError).
 */
function fakeIndexedDb() {
  const rows = new Map<string, { key: string; size: number; storedAt: number }>();
  const state = { quota: false, deletes: [] as string[] };
  const later = (fn: () => void) => setTimeout(fn, 0);
  const transaction = () => {
    const t: Record<string, unknown> & { onabort?: () => void; oncomplete?: () => void; error?: unknown } = {};
    const request = (run: () => unknown, fails = false) => {
      const req: Record<string, unknown> & { onsuccess?: () => void } = {};
      later(() => {
        if (fails) {
          t.error = new DOMException('quota', 'QuotaExceededError');
          t.onabort?.();
          return;
        }
        req.result = run();
        req.onsuccess?.();
        t.oncomplete?.();
      });
      return req;
    };
    t.objectStore = () => ({
      put: (rec: { key: string; size: number; storedAt: number }) => request(() => rows.set(rec.key, rec), state.quota),
      get: (key: string) => request(() => rows.get(key)),
      delete: (key: string) => request(() => (state.deletes.push(key), rows.delete(key))),
      index: () => ({
        openKeyCursor: () => {
          const req: Record<string, unknown> & { onsuccess?: () => void } = {};
          const list = [...rows.values()];
          let i = 0;
          const step = () => {
            const row = list[i++];
            req.result = row ? { key: [row.size, row.storedAt], primaryKey: row.key, continue: () => later(step) } : null;
            req.onsuccess?.();
          };
          later(step);
          return req;
        },
      }),
    });
    return t;
  };
  const db = { transaction, objectStoreNames: { contains: () => true } };
  const indexedDB = {
    open: () => {
      const req: Record<string, unknown> & { onsuccess?: () => void } = { result: db };
      later(() => req.onsuccess?.());
      return req;
    },
  };
  return { indexedDB, rows, state };
}

describe('a download that cannot be stored', () => {
  let fake: ReturnType<typeof fakeIndexedDb>;
  beforeEach(() => {
    vi.resetModules();
    fake = fakeIndexedDb();
    vi.stubGlobal('indexedDB', fake.indexedDB);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leaves every installed file where it was (storage full, every write refused)', async () => {
    const { cachePut, cacheEntries } = await import('@/engine/model-cache');
    expect(await cachePut('https://hf.co/old/model.onnx', new ArrayBuffer(8), 'application/octet-stream')).toBe(true);
    expect(await cachePut('https://hf.co/old/config.json', new ArrayBuffer(2), 'application/json')).toBe(true);

    fake.state.quota = true;
    expect(await cachePut('https://hf.co/new/model.onnx', new ArrayBuffer(16), 'application/octet-stream')).toBe(false);

    expect(fake.state.deletes).toEqual([]);
    expect((await cacheEntries()).map((e) => e.key).sort()).toEqual(['https://hf.co/old/config.json', 'https://hf.co/old/model.onnx']);
  });

  it('a Download button says what to do', async () => {
    const { fetchModelFile } = await import('@/engine/model-cache');
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('navigator', { locks: { request: (_name: string, a: unknown, b?: unknown) => (typeof a === 'function' ? a() : (b as () => unknown)()) } });
    fake.state.quota = true;
    await expect(fetchModelFile('https://hf.co/new/voice.onnx', { label: 'voice', mustStore: true })).rejects.toThrow(/delete a voice you do not use/);
  });
});
