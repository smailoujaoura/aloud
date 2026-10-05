/**
 * What a stored record must look like before anything reads it.
 *
 * History, reading positions, per-site speeds and PDF marks are maps of records. They arrive from
 * two places that cannot be trusted to have the right shape: a backup file, which anyone can edit,
 * and storage written by an older version or already damaged by such a file. A `null` where a
 * history entry should be used to reach `continueList` and throw, taking the Library page with it.
 *
 * Each `normalize…` returns the record with its fields checked — or null, and the record is
 * dropped. `recordsOf` applies one to a whole map. The same functions guard both the backup import
 * and every read from storage, so a bad value is refused on the way in and repaired on the way out.
 */
import { normalizeSource } from './doc-source';
import type { HistoryEntry } from './reading-history';
import type { SavedPosition } from './position-match';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown, fallback = 0): number => (finite(v) && v >= 0 ? v : fallback);

/** Keep the entries of `map` that `normalize` accepts, as it returns them. */
export function recordsOf<T>(map: unknown, normalize: (value: unknown) => T | null): Record<string, T> {
  if (!isObject(map)) return {};
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key) continue;
    const ok = normalize(value);
    if (ok != null) out[key] = ok;
  }
  return out;
}

export function normalizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isObject(raw)) return null;
  const source = normalizeSource(raw.source);
  if (!source) return null;
  const total = count(raw.total);
  const lastReadAt = count(raw.lastReadAt);
  return {
    source,
    index: Math.min(count(raw.index), total),
    total,
    charsRead: count(raw.charsRead),
    charsTotal: count(raw.charsTotal),
    listenedSeconds: count(raw.listenedSeconds),
    secondsPerChar: finite(raw.secondsPerChar) && raw.secondsPerChar > 0 ? raw.secondsPerChar : null,
    finished: raw.finished === true,
    firstReadAt: count(raw.firstReadAt, lastReadAt),
    lastReadAt,
  };
}

export function normalizePosition(raw: unknown): SavedPosition | null {
  if (!isObject(raw) || !finite(raw.index) || raw.index < 0) return null;
  return {
    index: Math.floor(raw.index),
    total: count(raw.total),
    excerpt: typeof raw.excerpt === 'string' ? raw.excerpt : '',
    savedAt: count(raw.savedAt),
  };
}

export function normalizeSiteSpeed(raw: unknown): { rate: number; at: number } | null {
  if (!isObject(raw) || !finite(raw.rate) || raw.rate <= 0 || raw.rate > 16) return null;
  return { rate: raw.rate, at: count(raw.at) };
}

const MARK_KINDS = ['highlight', 'underline', 'strike', 'note'] as const;
type MarkKind = (typeof MARK_KINDS)[number];

/** A PDF's saved marks (pdf/annotations/store.ts: StoredMarks), with each mark checked. */
export function normalizeStoredMarks(raw: unknown): { name: string; marks: unknown[]; updated: number } | null {
  if (!isObject(raw) || !Array.isArray(raw.marks)) return null;
  const marks = raw.marks.filter((m): m is Record<string, unknown> => {
    if (!isObject(m)) return false;
    return (
      typeof m.id === 'string' &&
      finite(m.page) &&
      m.page >= 1 &&
      MARK_KINDS.includes(m.kind as MarkKind) &&
      typeof m.color === 'string' &&
      // At least one box: a mark is drawn from its boxes, and a note from its first. `every` on an
      // empty list is true, so `[]` used to pass — and the PDF it belonged to failed to open.
      Array.isArray(m.boxes) &&
      m.boxes.length > 0 &&
      m.boxes.every((b) => Array.isArray(b) && b.length === 4 && b.every(finite))
    );
  }).map((m) => {
    const { origin, ...rest } = m;
    const checked = normalizeOrigin(origin);
    return {
      ...rest,
      text: typeof m.text === 'string' ? m.text : '',
      note: typeof m.note === 'string' ? m.note : '',
      created: count(m.created),
      updated: count(m.updated),
      ...(checked ? { origin: checked } : {}),
    };
  });
  return { name: typeof raw.name === 'string' ? raw.name : '', marks, updated: count(raw.updated) };
}

/**
 * Where an imported PDF mark came from (pdf/annotations/model.ts: MarkOrigin), field by field.
 *
 * Copied through unchecked, an author that was an array reached the PDF writer and made every
 * export of that document throw. A damaged field is dropped rather than the mark: the highlight
 * and its note are the reader's, the origin only says how to write them back. Without a usable
 * fingerprint the mark simply counts as edited, and is written out afresh.
 */
function normalizeOrigin(raw: unknown):
  | { ref: string | null; author: string; created: string | null; flags: number | null; fingerprint: string }
  | null {
  if (!isObject(raw)) return null;
  return {
    ref: typeof raw.ref === 'string' && /^\d+R\d*$/.test(raw.ref) ? raw.ref : null,
    author: typeof raw.author === 'string' ? raw.author : '',
    created: typeof raw.created === 'string' && raw.created.length <= 64 ? raw.created : null,
    flags: finite(raw.flags) && Number.isInteger(raw.flags) && raw.flags >= 0 ? raw.flags : null,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
  };
}
