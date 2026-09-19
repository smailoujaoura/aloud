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
import { MAX_NOTES, type Note } from './notes';
import type { QueueItem } from './reading-queue';
import { SETTINGS_VERSION, migrateSettings, withDefaults, type Settings } from './settings';

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
    notes: Array.isArray(b.notes) ? b.notes.filter(isNote) : [],
    queue: Array.isArray(b.queue) ? b.queue.filter((q) => q && typeof q === 'object' && typeof (q as QueueItem).id === 'string') : [],
    history: obj(b.history),
    positions: obj(b.positions),
    siteSpeeds: obj(b.siteSpeeds),
    pdfMarks: Object.fromEntries(Object.entries(obj(b.pdfMarks)).filter(([k]) => k.startsWith(PDF_MARKS_PREFIX))),
    models: {
      piper: Array.isArray(b.models?.piper) ? b.models.piper.filter((v): v is string => typeof v === 'string') : [],
      kokoro: b.models?.kokoro === true,
      supertonic: b.models?.supertonic === true,
    },
    shortcuts: Object.fromEntries(Object.entries(obj(b.shortcuts)).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
  };
}

function isNote(n: unknown): n is Note {
  const note = n as Note | null;
  return !!note && typeof note === 'object' && typeof note.id === 'string' && typeof note.text === 'string' && !!note.source;
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
  return withDefaults(migrateSettings(b.settings as Record<string, unknown>, b.settingsVersion) as Partial<Settings>);
}

/** Notes from both, one per id — the more recently edited copy — newest first. */
export function mergeNotes(here: readonly Note[], incoming: readonly Note[]): Note[] {
  const byId = new Map<string, Note>();
  for (const note of [...here, ...incoming]) {
    const have = byId.get(note.id);
    if (!have || (note.updatedAt ?? 0) > (have.updatedAt ?? 0)) byId.set(note.id, note);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NOTES);
}

/** The queue here, then what the backup has that is not already queued. */
export function mergeQueue(here: readonly QueueItem[], incoming: readonly QueueItem[]): QueueItem[] {
  const ids = new Set(here.map((q) => q.id));
  const urls = new Set(here.map((q) => q.url));
  return [...here, ...incoming.filter((q) => !ids.has(q.id) && !urls.has(q.url))];
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
      if (!(key in all) || stamp(value) > stamp(all[key])) out[key] = value;
    }
  }
  return out;
}

/** `aloud-backup-2026-09-19.json`. */
export function backupFileName(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `aloud-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}
