/**
 * One writer at a time for a stored value.
 *
 * Every store here is read-modify-write: load the notes, add one, write them all back. Two of
 * those overlapping lose one of the changes — both report success, and one note, queued article
 * or setting is silently gone. It is easy to do: the reading bar's bookmark and the notes panel's
 * delete, or two tabs of the same page, or a restore landing while a page is still reading.
 *
 * Serialising inside one context is not enough, because the contexts are separate JavaScript
 * worlds: a content script, the options page and the background all write the same keys. So a
 * write takes a lock from the **background**, which is the one context they all share, and holds
 * it for the read-modify-write. If the background cannot be reached — it is the caller, or this
 * is a test — the local queue alone still orders everything in this context.
 *
 * A holder that never releases (a tab closed mid-write) must not wedge the key, so the background
 * hands the lock on after `LOCK_TIMEOUT_MS` regardless.
 */
import { browser } from 'wxt/browser';

export const LOCK_TIMEOUT_MS = 5000;

/** The message the background answers with a lock. */
export interface LockRequest {
  type: 'storage-lock';
  key: string;
}
export interface LockRelease {
  type: 'storage-unlock';
  key: string;
  token: number;
}

/** In-context ordering: the promise each key's last waiter is waiting on. */
const queues = new Map<string, Promise<unknown>>();

export async function withStorageLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.then(() => holdAndRun(key, run), () => holdAndRun(key, run));
  // The chain must not break on a failed write, or the key would never be writable again.
  queues.set(key, mine.catch(() => undefined));
  return mine;
}

/**
 * Several keys at once — for a restore, which reads and rewrites nearly everything. Taken in a
 * fixed order, so two callers asking for overlapping sets can never each hold what the other waits
 * for. (Every other writer takes one key.)
 */
export async function withStorageLocks<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  const hold = (i: number): Promise<T> => (i === sorted.length ? run() : withStorageLock(sorted[i]!, () => hold(i + 1)));
  return hold(0);
}

async function holdAndRun<T>(key: string, run: () => Promise<T>): Promise<T> {
  const token = await acquire(key);
  try {
    return await run();
  } finally {
    if (token != null) void release(key, token);
  }
}

async function acquire(key: string): Promise<number | null> {
  try {
    const reply = (await browser.runtime.sendMessage({ type: 'storage-lock', key } satisfies LockRequest)) as
      | { token?: number }
      | undefined;
    return typeof reply?.token === 'number' ? reply.token : null;
  } catch {
    // No background to ask (it is the caller, or this is a test): local ordering only.
    return null;
  }
}

async function release(key: string, token: number): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'storage-unlock', key, token } satisfies LockRelease);
  } catch {
    /* the background will hand the lock on by itself */
  }
}

/**
 * The background's side: hand the key to one caller at a time.
 *
 * Returned as a plain object so the background can own it without importing a class, and so the
 * timeout can be driven by a test.
 */
export function createLockTable(now: () => number = Date.now, timeoutMs = LOCK_TIMEOUT_MS) {
  interface Held {
    token: number;
    since: number;
    waiting: Array<(token: number) => void>;
    timer: ReturnType<typeof setTimeout> | null;
  }
  const keys = new Map<string, Held>();
  let nextToken = 1;

  // Waiters already queued behind a holder that went away must not depend on some *new* caller
  // arriving to notice the timeout: each grant carries a deadline that hands the key on by itself.
  const watch = (key: string, held: Held): void => {
    if (held.timer) clearTimeout(held.timer);
    const token = held.token;
    held.timer = setTimeout(() => {
      held.timer = null;
      if (keys.get(key) === held && held.token === token) handOn(key, held);
    }, timeoutMs + 1);
  };

  const handOn = (key: string, held: Held): void => {
    const next = held.waiting.shift();
    if (!next) {
      if (held.timer) clearTimeout(held.timer);
      keys.delete(key);
      return;
    }
    held.token = nextToken++;
    held.since = now();
    watch(key, held);
    next(held.token);
  };

  return {
    /** Resolves with a token once this caller owns `key`. */
    acquire(key: string): Promise<number> {
      const held = keys.get(key);
      if (!held) {
        const token = nextToken++;
        const fresh: Held = { token, since: now(), waiting: [], timer: null };
        keys.set(key, fresh);
        watch(key, fresh);
        return Promise.resolve(token);
      }
      // A holder that went away (a closed tab) must not wedge the key for everyone else.
      if (now() - held.since > timeoutMs) {
        return new Promise<number>((resolve) => {
          held.waiting.unshift(resolve);
          handOn(key, held);
        });
      }
      return new Promise<number>((resolve) => held.waiting.push(resolve));
    },

    release(key: string, token: number): void {
      const held = keys.get(key);
      // A late release from a holder that already timed out must not free someone else's lock.
      if (!held || held.token !== token) return;
      handOn(key, held);
    },

    /** How many keys are held right now — for tests and diagnosis. */
    get size(): number {
      return keys.size;
    },
  };
}
