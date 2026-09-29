import { describe, expect, it, vi } from 'vitest';
import { createLockTable } from '@/shared/storage-lock';

describe('the background’s lock table', () => {
  it('hands a key to one caller at a time, in order', async () => {
    const locks = createLockTable();
    const first = await locks.acquire('notes');
    const order: string[] = [];
    const second = locks.acquire('notes').then(() => order.push('second'));
    const third = locks.acquire('notes').then(() => order.push('third'));
    await Promise.resolve();
    expect(order).toEqual([]);
    locks.release('notes', first);
    await second;
    locks.release('notes', 2);
    await third;
    expect(order).toEqual(['second', 'third']);
  });

  it('keeps separate keys independent', async () => {
    const locks = createLockTable();
    await locks.acquire('notes');
    await expect(locks.acquire('queue')).resolves.toBeTypeOf('number');
  });

  it('hands the key on when a holder goes away without releasing', async () => {
    let now = 0;
    const locks = createLockTable(() => now, 5000);
    await locks.acquire('notes');
    now = 6000; // the tab that held it was closed
    await expect(locks.acquire('notes')).resolves.toBeTypeOf('number');
  });

  it('ignores a release from a holder that already timed out', async () => {
    let now = 0;
    const locks = createLockTable(() => now, 5000);
    const stale = await locks.acquire('notes');
    now = 6000;
    const next = await locks.acquire('notes');
    locks.release('notes', stale);
    // The key still belongs to `next`, so a waiter must keep waiting.
    let granted = false;
    void locks.acquire('notes').then(() => (granted = true));
    await Promise.resolve();
    expect(granted).toBe(false);
    locks.release('notes', next);
    await Promise.resolve();
    expect(granted).toBe(true);
  });

  it('frees the key once nobody is waiting', async () => {
    const locks = createLockTable();
    const token = await locks.acquire('notes');
    expect(locks.size).toBe(1);
    locks.release('notes', token);
    expect(locks.size).toBe(0);
  });

  it('hands the key to a waiter when the holder goes away, with no new caller to notice', async () => {
    vi.useFakeTimers();
    try {
      const locks = createLockTable(Date.now, 5000);
      await locks.acquire('notes'); // this holder's tab closes and never releases
      let granted = false;
      void locks.acquire('notes').then(() => (granted = true));
      await vi.advanceTimersByTimeAsync(4000);
      expect(granted).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(granted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a holder that released in time', async () => {
    vi.useFakeTimers();
    try {
      const locks = createLockTable(Date.now, 5000);
      const first = await locks.acquire('notes');
      locks.release('notes', first);
      const second = await locks.acquire('notes');
      let third = false;
      void locks.acquire('notes').then(() => (third = true));
      await vi.advanceTimersByTimeAsync(3000); // the first grant's deadline must not fire for `second`
      expect(third).toBe(false);
      locks.release('notes', second);
      await Promise.resolve();
      expect(third).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('taking several keys', () => {
  it('runs once every key is free, and lets single-key writers queue behind it', async () => {
    const { withStorageLock, withStorageLocks } = await import('@/shared/storage-lock');
    const order: string[] = [];
    let release!: () => void;
    const blocker = withStorageLock('notes', () => new Promise<void>((r) => (release = () => { order.push('note'); r(); })));
    const restore = withStorageLocks(['queue', 'notes'], async () => void order.push('restore'));
    const after = withStorageLock('queue', async () => void order.push('queue'));
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([blocker, restore, after]);
    expect(order.indexOf('note')).toBeLessThan(order.indexOf('restore'));
  });
});
