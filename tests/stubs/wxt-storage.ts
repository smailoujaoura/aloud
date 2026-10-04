/**
 * The storage WXT gives the extension, as the tests get it.
 *
 * `storage.defineItem` runs its migrations as soon as a module defines an item, and migrations
 * talk to `browser.runtime`, which does not exist under Node or happy-dom. Importing
 * `shared/settings.ts` from a test therefore started a migration that rejected in the background:
 * every assertion passed and `npm test` still exited 1, which is the worst possible shape for a
 * release gate.
 *
 * So tests resolve `wxt/utils/storage` to this instead (see vitest.config.ts): the same surface,
 * backed by a map, with no browser and no migrations. Values are structured-cloned on the way in
 * and out, so a test cannot mutate what another test reads.
 */

type Watcher<T> = (newValue: T | null, oldValue: T | null) => void;

export interface StorageItem<T> {
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
  removeValue(): Promise<void>;
  watch(cb: Watcher<T>): () => void;
  migrate(): Promise<void>;
}

const values = new Map<string, unknown>();
const watchers = new Map<string, Set<Watcher<unknown>>>();

const clone = <T>(value: T): T => (value == null ? value : (structuredClone(value) as T));

function read<T>(key: string, fallback: T): T {
  return values.has(key) ? clone(values.get(key) as T) : clone(fallback);
}

export const storage = {
  defineItem<T>(key: string, opts: { fallback?: T } = {}): StorageItem<T> {
    const fallback = opts.fallback as T;
    return {
      async getValue() {
        return read(key, fallback);
      },
      async setValue(value: T) {
        const before = values.has(key) ? (values.get(key) as T) : null;
        values.set(key, clone(value));
        for (const cb of watchers.get(key) ?? []) cb(clone(value), clone(before));
      },
      async removeValue() {
        values.delete(key);
        for (const cb of watchers.get(key) ?? []) cb(null, null);
      },
      watch(cb: Watcher<T>) {
        const set = watchers.get(key) ?? new Set();
        set.add(cb as Watcher<unknown>);
        watchers.set(key, set);
        return () => set.delete(cb as Watcher<unknown>);
      },
      async migrate() {
        /* nothing to migrate in a map */
      },
    };
  },

  async getItem<T>(key: string): Promise<T | null> {
    return values.has(key) ? clone(values.get(key) as T) : null;
  },

  async setItem<T>(key: string, value: T): Promise<void> {
    values.set(key, clone(value));
    for (const cb of watchers.get(key) ?? []) cb(clone(value), null);
  },

  async removeItem(key: string): Promise<void> {
    values.delete(key);
  },

  watch<T>(key: string, cb: Watcher<T>): () => void {
    const set = watchers.get(key) ?? new Set();
    set.add(cb as Watcher<unknown>);
    watchers.set(key, set);
    return () => set.delete(cb as Watcher<unknown>);
  },
};

/** Empty every item — for a test that wants to start from nothing. */
export function resetStorage(): void {
  values.clear();
  watchers.clear();
}
