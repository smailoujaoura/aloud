// @vitest-environment happy-dom
/**
 * The eleventh-and-a-half pass (AG01): a deletion in one settings tab must not run while another
 * page is downloading or loading a voice — the cache is shared, the download queue is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asModelWriter, deleteModels, ModelsInUse } from '@/engine/model-cache';
import { DownloadQueue } from '@/entrypoints/options/download-queue';

/** Web Locks, as far as these tests need: shared holders together, exclusive only when free. */
function fakeLocks() {
  const held = new Map<string, { shared: number; exclusive: boolean }>();
  return {
    async request(name: string, opts: { mode?: 'shared' | 'exclusive'; ifAvailable?: boolean }, fn: (lock: unknown) => Promise<unknown>) {
      const state = held.get(name) ?? { shared: 0, exclusive: false };
      held.set(name, state);
      const exclusive = opts.mode !== 'shared';
      const free = exclusive ? state.shared === 0 && !state.exclusive : !state.exclusive;
      if (!free) {
        if (opts.ifAvailable) return fn(null);
        throw new Error('the fake does not queue');
      }
      if (exclusive) state.exclusive = true;
      else state.shared++;
      try {
        return await fn({ name });
      } finally {
        if (exclusive) state.exclusive = false;
        else state.shared--;
      }
    },
  };
}

describe('deleting models while something writes them', () => {
  beforeEach(() => vi.stubGlobal('navigator', { ...navigator, locks: fakeLocks() }));
  afterEach(() => vi.unstubAllGlobals());

  it('refuses while a download anywhere holds the cache, and runs once it is done', async () => {
    let finish!: () => void;
    const download = asModelWriter(() => new Promise<void>((ok) => (finish = ok)));
    const deleted = vi.fn(async () => {});
    await expect(deleteModels(deleted)).rejects.toBeInstanceOf(ModelsInUse);
    expect(deleted).not.toHaveBeenCalled();

    finish();
    await download;
    await expect(deleteModels(deleted)).resolves.toBeUndefined();
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('lets two downloads write side by side', async () => {
    let a!: () => void;
    let b!: () => void;
    const one = asModelWriter(() => new Promise<void>((ok) => (a = ok)));
    const two = asModelWriter(() => new Promise<void>((ok) => (b = ok)));
    a();
    b();
    await expect(Promise.all([one, two])).resolves.toBeDefined();
  });
});

describe('a row replaced on its own (AG02)', () => {
  it('stopping it ends its subscription, and the scope keeps nothing of it', () => {
    const q = new DownloadQueue();
    const scope = new AbortController();
    const added = vi.spyOn(scope.signal, 'addEventListener');
    const removed = vi.spyOn(scope.signal, 'removeEventListener');
    const stops = Array.from({ length: 60 }, () => q.subscribe(() => {}, scope.signal));
    expect(q.listenerCount).toBe(60);
    for (const stop of stops) stop();
    expect(q.listenerCount).toBe(0);
    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
  });
});
