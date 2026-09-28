import { describe, expect, it } from 'vitest';
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
});
