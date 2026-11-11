/**
 * Two copies of one list that each changed since they last agreed, made one again.
 *
 * Three lists of records with ids: `baseline`, what both sides held when they last agreed;
 * `current`, one side now; `latest`, the other side now. The result is `latest` with `current`'s
 * changes since `baseline` applied to it. Per record:
 * - changed here, untouched there: ours;
 * - changed in both since the baseline: the later `updated` wins;
 * - deleted here, untouched there: deleted;
 * - deleted here, but edited there afterwards: kept, so a deletion never silently takes someone's
 *   later work with it;
 * - added anywhere: kept.
 *
 * First written for a PDF's marks open in two tabs (pdf/annotations/sync.ts); the same rules make
 * notes and marks from two devices one (sync/cloud-sync.ts).
 */

/** JSON with every object's keys in order: the same value always gives the same text. */
export function canon(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** The same rules for a map of records by key (reading positions by document). */
export function reconcileMaps<V>(
  latest: Readonly<Record<string, V>>,
  baseline: Readonly<Record<string, V>>,
  current: Readonly<Record<string, V>>,
  updatedOf: (value: V) => number,
): Record<string, V> {
  const records = (map: Readonly<Record<string, V>>) => Object.entries(map).map(([id, value]) => ({ id, value }));
  const merged = reconcileById(records(latest), records(baseline), records(current), (r) => updatedOf(r.value));
  return Object.fromEntries(merged.map((r) => [r.id, r.value]));
}

export function reconcileById<T extends { id: string }>(
  latest: readonly T[],
  baseline: readonly T[],
  current: readonly T[],
  updatedOf: (record: T) => number,
): T[] {
  const same = (a: T, b: T): boolean => canon(a) === canon(b);
  const result = new Map(latest.map((r) => [r.id, r]));
  const base = new Map(baseline.map((r) => [r.id, r]));
  const mine = new Map(current.map((r) => [r.id, r]));

  for (const [id, before] of base) {
    if (mine.has(id)) continue;
    // Deleted here. Gone there too, or unchanged there since: delete. Edited there since: keep.
    const theirs = result.get(id);
    if (theirs && updatedOf(theirs) <= updatedOf(before)) result.delete(id);
  }
  for (const record of current) {
    const before = base.get(record.id);
    if (before && same(before, record)) continue; // not changed here: whatever is there stands
    const theirs = result.get(record.id);
    const changedThere = before ? theirs != null && !same(theirs, before) : theirs != null;
    if (!changedThere || updatedOf(record) >= (theirs ? updatedOf(theirs) : 0)) result.set(record.id, record);
  }
  return [...result.values()];
}
