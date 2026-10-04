/**
 * Backup and restore: everything Aloud keeps, in one JSON file.
 *
 * In the file: every setting (voices, speeds, keys, colours, sites), notes, the reading queue,
 * history and positions, remembered video speeds, PDF marks — and, since the models themselves
 * are hundreds of megabytes, a list of which voices were downloaded, so restoring can offer to
 * fetch them again. The browser's own keyboard shortcuts are recorded too; Firefox lets Aloud
 * set them back, Chromium only lets you do it on its shortcuts page.
 *
 * Restoring replaces the settings and *merges* everything else: a note, queued article or
 * position already here is kept unless the backup's copy is newer, so restoring an old backup
 * never throws away what was kept since.
 */
import { MAX_NOTES, mergeNoteLists, normalizeNote, type Note } from './notes';
import { MAX_QUEUE, type QueueItem } from './reading-queue';
import { documentKey } from './position-match';
import { normalizeHistoryEntry, normalizePosition, normalizeSiteSpeed, normalizeStoredMarks, recordsOf } from './record-shapes';
import { SETTINGS_VERSION, migrateSettings, sanitizeSettings, withDefaults, type Settings } from './settings';
import { markFingerprint, type Mark } from '@/pdf/annotations/model';

export const BACKUP_FORMAT = 'aloud-backup';
export const BACKUP_VERSION = 1;

export interface BackupModels {
  /** Piper voice ids that were downloaded. */
  piper: string[];
  kokoro: boolean;
  supertonic: boolean;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** Aloud's version that wrote it, for reference. */
  aloud: string;
  settingsVersion: number;
  settings: Partial<Settings> | null;
  notes: Note[];
  queue: QueueItem[];
  history: Record<string, unknown>;
  positions: Record<string, unknown>;
  siteSpeeds: Record<string, unknown>;
  /** Stored PDF marks, by storage key (`pdfMarks:<hash>`). */
  pdfMarks: Record<string, unknown>;
  models: BackupModels;
  /** Command name → shortcut as the browser reports it ('' = none). */
  shortcuts: Record<string, string>;
}

/** The storage.local keys each part lives under. */
export const STORAGE_KEYS = {
  settings: 'settings',
  notes: 'notes',
  queue: 'readingQueue',
  history: 'readingHistory',
  positions: 'readingPositions',
  siteSpeeds: 'mediaSpeedSites',
} as const;
export const PDF_MARKS_PREFIX = 'pdfMarks:';

export type BackupPart = 'settings' | 'notes' | 'library' | 'speeds' | 'pdfMarks' | 'shortcuts';
export const BACKUP_PARTS: readonly BackupPart[] = ['settings', 'notes', 'library', 'speeds', 'pdfMarks', 'shortcuts'];

/** Build a backup from everything in storage.local (`all`) plus what only the page can know. */
export function makeBackup(
  all: Record<string, unknown>,
  extra: { aloud: string; models: BackupModels; shortcuts: Record<string, string>; now?: Date },
): Backup {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const pdfMarks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(all)) if (key.startsWith(PDF_MARKS_PREFIX)) pdfMarks[key] = value;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: (extra.now ?? new Date()).toISOString(),
    aloud: extra.aloud,
    settingsVersion: SETTINGS_VERSION,
    settings: (all[STORAGE_KEYS.settings] as Partial<Settings> | undefined) ?? null,
    notes: Array.isArray(all[STORAGE_KEYS.notes]) ? (all[STORAGE_KEYS.notes] as Note[]) : [],
    queue: Array.isArray(all[STORAGE_KEYS.queue]) ? (all[STORAGE_KEYS.queue] as QueueItem[]) : [],
    history: obj(all[STORAGE_KEYS.history]),
    positions: obj(all[STORAGE_KEYS.positions]),
    siteSpeeds: obj(all[STORAGE_KEYS.siteSpeeds]),
    pdfMarks,
    models: extra.models,
    shortcuts: extra.shortcuts,
  };
}

/** A parsed file, checked for being one of ours. Throws with a readable message otherwise. */
export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not a backup: it is not JSON.');
  }
  const b = data as Partial<Backup> | null;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) throw new Error('That file is not an Aloud backup.');
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    throw new Error('That backup was made by a newer Aloud. Update Aloud, then restore it.');
  }
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  return {
    format: BACKUP_FORMAT,
    version: b.version,
    exportedAt: String(b.exportedAt ?? ''),
    aloud: String(b.aloud ?? ''),
    settingsVersion: typeof b.settingsVersion === 'number' ? b.settingsVersion : 1,
    settings: b.settings && typeof b.settings === 'object' ? b.settings : null,
    notes: Array.isArray(b.notes) ? b.notes.map((n) => normalizeNote(n)).filter((n): n is Note => n != null) : [],
    queue: Array.isArray(b.queue) ? b.queue.map(normalizeQueueItem).filter((q): q is QueueItem => q != null) : [],
    // Every record checked before it can reach storage (shared/record-shapes.ts): a `null` history
    // entry used to be restored as it was, and the Library threw on it from then on.
    history: recordsOf(b.history, normalizeHistoryEntry),
    positions: recordsOf(b.positions, normalizePosition),
    siteSpeeds: recordsOf(b.siteSpeeds, normalizeSiteSpeed),
    pdfMarks: recordsOf(
      Object.fromEntries(Object.entries(obj(b.pdfMarks)).filter(([k]) => k.startsWith(PDF_MARKS_PREFIX))),
      normalizeStoredMarks,
    ),
    models: {
      piper: Array.isArray(b.models?.piper) ? b.models.piper.filter((v): v is string => typeof v === 'string') : [],
      kokoro: b.models?.kokoro === true,
      supertonic: b.models?.supertonic === true,
    },
    shortcuts: Object.fromEntries(Object.entries(obj(b.shortcuts)).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
  };
}

/**
 * A queued article from a file. Anything without a usable address cannot be played or removed
 * sensibly, so it is dropped rather than restored as an entry that does nothing.
 */
function normalizeQueueItem(raw: unknown): QueueItem | null {
  const item = raw as Partial<QueueItem> | null;
  if (!item || typeof item !== 'object' || typeof item.url !== 'string') return null;
  try {
    new URL(item.url);
  } catch {
    return null;
  }
  const article =
    item.article && typeof item.article === 'object' && typeof item.article.text === 'string'
      ? {
          html: typeof item.article.html === 'string' ? item.article.html : '',
          text: item.article.text,
          lang: typeof item.article.lang === 'string' ? item.article.lang : '',
          byline: typeof item.article.byline === 'string' ? item.article.byline : null,
        }
      : undefined;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `restored-${Math.random().toString(36).slice(2, 10)}`,
    url: item.url,
    title: typeof item.title === 'string' && item.title ? item.title : item.url,
    site: typeof item.site === 'string' ? item.site : '',
    addedAt: Number.isFinite(item.addedAt) ? (item.addedAt as number) : Date.now(),
    ...(article ? { article } : {}),
  };
}

/** One line per part: what restoring would bring in. */
export function describeBackup(b: Backup): Record<BackupPart, string> {
  const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
  const voices = b.models.piper.length + (b.models.kokoro ? 1 : 0) + (b.models.supertonic ? 1 : 0);
  return {
    settings: !b.settings ? 'No settings in this file' : voices ? `every setting, and ${n(voices, 'voice model')} to download again` : 'every setting',
    notes: n(b.notes.length, 'note'),
    library: `${n(b.queue.length, 'queued article')}, ${n(Object.keys(b.history).length, 'history entry', 'history entries')}, ${n(Object.keys(b.positions).length, 'reading position')}`,
    speeds: n(Object.keys(b.siteSpeeds).length, 'remembered site speed'),
    pdfMarks: n(Object.keys(b.pdfMarks).length, 'marked-up PDF'),
    shortcuts: n(Object.values(b.shortcuts).filter(Boolean).length, 'keyboard shortcut'),
  };
}

/** The backup's settings, brought up to this version, with defaults for anything missing. */
export function restoredSettings(b: Backup): Settings | null {
  if (!b.settings) return null;
  // Migrated, defaulted, *and* checked: a file can carry a negative speed or an engine that does
  // not exist, and those reach every part of the reader once they are in storage.
  return sanitizeSettings(withDefaults(migrateSettings(b.settings as Record<string, unknown>, b.settingsVersion) as Partial<Settings>));
}

/** Notes from both, one per id — the more recently edited copy — newest first. */
export function mergeNotes(here: readonly Note[], incoming: readonly Note[]): Note[] {
  // Over the cap, what is already here outranks what the file brought (shared/notes.ts);
  // `overflowOf` reports how many were left out.
  return mergeNoteLists(here, incoming).notes;
}

/** The queue here, then what the backup has that is not already queued. */
export function mergeQueue(here: readonly QueueItem[], incoming: readonly QueueItem[]): QueueItem[] {
  const ids = new Set(here.map((q) => q.id));
  // Documents, not addresses: `?utm_source=` should not make the same article a second entry.
  const keys = new Set(here.map((q) => documentKey(q.url)));
  const merged = [...here];
  for (const item of incoming) {
    const key = documentKey(item.url);
    // Each accepted entry joins the sets, or a file holding the same article twice adds it twice.
    if (ids.has(item.id) || keys.has(key)) continue;
    if (merged.length >= MAX_QUEUE) break;
    ids.add(item.id);
    keys.add(key);
    merged.push(item);
  }
  return merged;
}

/** Notes a restore could not take: shown rather than silently dropped. */
export interface MergeOverflow {
  notes: number;
  queue: number;
}

/** What `restorePlan` had to leave out, for the page to report. */
export function overflowOf(b: Backup, all: Record<string, unknown>): MergeOverflow {
  const notesHere = Array.isArray(all[STORAGE_KEYS.notes]) ? (all[STORAGE_KEYS.notes] as Note[]) : [];
  const queueHere = Array.isArray(all[STORAGE_KEYS.queue]) ? (all[STORAGE_KEYS.queue] as QueueItem[]) : [];
  const notesWanted = new Set([...notesHere, ...b.notes].map((n) => n.id)).size;
  const queueWanted = mergeQueueUncapped(queueHere, b.queue).length;
  return {
    notes: Math.max(0, notesWanted - MAX_NOTES),
    queue: Math.max(0, queueWanted - MAX_QUEUE),
  };
}

function mergeQueueUncapped(here: readonly QueueItem[], incoming: readonly QueueItem[]): QueueItem[] {
  const ids = new Set(here.map((q) => q.id));
  const keys = new Set(here.map((q) => documentKey(q.url)));
  const merged = [...here];
  for (const item of incoming) {
    const key = documentKey(item.url);
    if (ids.has(item.id) || keys.has(key)) continue;
    ids.add(item.id);
    keys.add(key);
    merged.push(item);
  }
  return merged;
}

/** Records keyed by document or site: the entry touched most recently wins. */
export function mergeRecords(here: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out = { ...here };
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in out) || stamp(value) > stamp(out[key])) out[key] = value;
  }
  return out;
}

function stamp(v: unknown): number {
  const r = v as { lastReadAt?: number; savedAt?: number; updated?: number; updatedAt?: number; at?: number } | null;
  if (!r || typeof r !== 'object') return 0;
  return r.lastReadAt ?? r.savedAt ?? r.updatedAt ?? r.updated ?? r.at ?? 0;
}

/**
 * What to write into storage.local to restore `parts` of `b` over what is there now (`all`).
 * Settings are replaced; everything else is merged.
 */
export function restorePlan(b: Backup, all: Record<string, unknown>, parts: ReadonlySet<BackupPart>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  if (parts.has('settings')) {
    const settings = restoredSettings(b);
    if (settings) out[STORAGE_KEYS.settings] = settings;
  }
  if (parts.has('notes') && b.notes.length) {
    out[STORAGE_KEYS.notes] = mergeNotes(Array.isArray(all[STORAGE_KEYS.notes]) ? (all[STORAGE_KEYS.notes] as Note[]) : [], b.notes);
  }
  if (parts.has('library')) {
    if (b.queue.length) {
      out[STORAGE_KEYS.queue] = mergeQueue(Array.isArray(all[STORAGE_KEYS.queue]) ? (all[STORAGE_KEYS.queue] as QueueItem[]) : [], b.queue);
    }
    if (Object.keys(b.history).length) out[STORAGE_KEYS.history] = mergeRecords(obj(all[STORAGE_KEYS.history]), b.history);
    if (Object.keys(b.positions).length) out[STORAGE_KEYS.positions] = mergeRecords(obj(all[STORAGE_KEYS.positions]), b.positions);
  }
  if (parts.has('speeds') && Object.keys(b.siteSpeeds).length) {
    out[STORAGE_KEYS.siteSpeeds] = mergeRecords(obj(all[STORAGE_KEYS.siteSpeeds]), b.siteSpeeds);
  }
  if (parts.has('pdfMarks')) {
    for (const [key, value] of Object.entries(b.pdfMarks)) {
      const here = normalizeStoredMarks(all[key]);
      const merged = here ? mergePdfMarks(here, value as StoredMarksRecord) : value;
      if (merged !== here) out[key] = merged;
    }
  }
  return out;
}

type StoredMarksRecord = NonNullable<ReturnType<typeof normalizeStoredMarks>>;
type MarkRecord = { id: string; updated: number; origin?: { ref: string | null; fingerprint: string } };

/**
 * One PDF's marks from a backup, into the marks this device has for it.
 *
 * Mark by mark, the newer copy of each winning, and every mark only one side has kept. Choosing
 * the whole document's record by its date deleted every mark made here since the backup — under
 * a screen promising that nothing kept since would be lost. A mark deleted here that the backup
 * still has comes back: of the two ways to be wrong, that is the one that loses nothing.
 *
 * Returns `here` itself when the backup adds nothing, so the caller can skip the write.
 */
export function mergePdfMarks(here: StoredMarksRecord, incoming: StoredMarksRecord): StoredMarksRecord {
  // One annotation of the file is one mark, whatever id each device gave it: imported marks are
  // matched by the annotation they came from. (Before ids came from the annotation, two devices
  // opening the same PDF named the same note differently, and a restore kept both.)
  const keyOf = (m: MarkRecord): string => (m.origin?.ref ? `ref:${m.origin.ref}` : `id:${m.id}`);
  // An imported mark nobody edited is not "newer" for having been imported later: it must not
  // replace an edit made on the other device.
  const when = (m: MarkRecord): number =>
    m.origin && markFingerprint(m as unknown as Mark) === m.origin.fingerprint ? 0 : m.updated;
  const byKey = new Map<string, MarkRecord>((here.marks as MarkRecord[]).map((m) => [keyOf(m), m]));
  let changed = false;
  for (const mark of incoming.marks as MarkRecord[]) {
    const have = byKey.get(keyOf(mark));
    if (!have || when(mark) > when(have)) {
      byKey.set(keyOf(mark), have ? { ...mark, id: have.id } : mark);
      changed = true;
    }
  }
  if (!changed) return here;
  return { name: here.name || incoming.name, marks: [...byKey.values()], updated: Math.max(here.updated, incoming.updated) };
}

/** `aloud-backup-2026-09-19.json`. */
export function backupFileName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `aloud-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}
