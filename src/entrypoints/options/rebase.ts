/**
 * A save from a panel that holds its own copy (the pronunciation editor, the key recorders, the
 * video speed panel): what the panel changed since it was drawn, applied to the settings as they
 * are now. Saving the panel's whole copy put back whatever had changed meanwhile, another device's
 * pronunciation or key arriving through Dropbox among them, and sync then spread that everywhere.
 */
import { canon } from '@/shared/three-way';
import { mergeRuleLists } from '@/sync/synced-settings';

const isPlain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string');

/** `mine`'s changes since `base`, on top of `now`: objects field by field, lists of names item by item. */
export function rebase<T>(now: T, base: T, mine: T): T {
  if (strings(now) && strings(base) && strings(mine)) {
    const removed = new Set(base.filter((x) => !mine.includes(x)));
    const added = mine.filter((x) => !base.includes(x) && !now.includes(x));
    return [...now.filter((x) => !removed.has(x)), ...added] as T;
  }
  if (isPlain(now) && isPlain(base) && isPlain(mine)) {
    const out: Record<string, unknown> = { ...now };
    for (const field of new Set([...Object.keys(mine), ...Object.keys(base)])) {
      if (canon(mine[field]) === canon(base[field])) continue;
      if (field in mine) out[field] = rebase(now[field], base[field], mine[field]);
      else delete out[field];
    }
    return out as T;
  }
  return mine;
}

/** The pronunciation editor's list, rule by rule, on top of the stored one. */
export function rebaseRules<T>(now: T[], base: T[], mine: T[]): T[] {
  return mergeRuleLists(now, base, mine) as T[];
}
