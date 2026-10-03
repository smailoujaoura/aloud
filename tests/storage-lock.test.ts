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

describe('a holder that is still working', () => {
  it('keeps the lock past the timeout while it renews, and loses it once it stops', async () => {
    vi.useFakeTimers();
    try {
      const locks = createLockTable(Date.now, 5000);
      const token = await locks.acquire('notes');
      let waiter = false;
      void locks.acquire('notes').then(() => (waiter = true));
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(1600);
        expect(locks.renew('notes', token)).toBe(true); // a slow write, still alive
      }
      expect(waiter).toBe(false); // ~10 s in: never handed on under a running writer
      await vi.advanceTimersByTimeAsync(6000); // renewals stop: the holder has gone away
      expect(waiter).toBe(true);
      expect(locks.renew('notes', token)).toBe(false); // and a late renewal cannot take it back
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the background, which cannot message itself', () => {
  it('takes locks from its own table, in the same order as everyone else', async () => {
    const { withStorageLock, useLockTable } = await import('@/shared/storage-lock');
    const table = createLockTable();
    useLockTable(table);
    // Another context holds the key through the table (as a message would have taken it).
    const other = await table.acquire('queue');
    let ran = false;
    const mine = withStorageLock('queue', async () => void (ran = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(false); // waits for the other context, rather than writing alongside it
    table.release('queue', other);
    await mine;
    expect(ran).toBe(true);
    expect(table.size).toBe(0);
  });
});
