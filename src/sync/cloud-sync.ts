/**
 * Notes, PDF marks, settings (sync/synced-settings.ts), where the reader stopped in each document
 * and what they listened to (the Library's Continue and History lists), kept in step between devices
 * through one file in the reader's own storage (Dropbox: Apps/Aloud-tts/aloud.json).
 *
 * Each device remembers the file as it last agreed with it (`base`). A round reads the file, and
 * makes one list of three: the file now, this device now, and that base (shared/three-way.ts:
 * changed on one side, that side's; on both, the later edit; deleted on one side and untouched on
 * the other, deleted; deleted but edited elsewhere afterwards, kept). The result is written to
 * the file only over the revision that was read, so a device that wrote in between is never
 * overwritten: the round starts again from its version. Then it is written here, with whatever
 * changed here while the round ran kept on top.
 *
 * The file being gone (the reader deleted it, or this is the first device) is never read as
 * "everything was deleted": the round starts again from this device's notes, unmerged.
 */
import { storage } from 'wxt/utils/storage';
import { withStorageLock } from '@/shared/storage-lock';
import { canon, reconcileById, reconcileMaps } from '@/shared/three-way';
import { normalizeNote, type Note } from '@/shared/notes';
import { normalizeHistoryEntry, normalizePosition, normalizeStoredMarks, recordsOf } from '@/shared/record-shapes';
import { MAX_HISTORY, type History } from '@/shared/reading-history';
import { SETTINGS_VERSION, migrateSettings } from '@/shared/settings';
import { isSyncedSetting, mergeSettings, type SyncedSettings } from './synced-settings';
import { MAX_SAVED_POSITIONS, type PositionMap } from '@/shared/position-match';
import type { Mark } from '@/pdf/annotations/model';

export const SYNC_FORMAT = 'aloud-sync';
/**
 * The file's layout. Raise it whenever a later Aloud adds a section, or a field to any record:
 * an older Aloud refuses a newer file (and says to update) rather than read it, drop what it does
 * not know, and write it back without it, which every newer device would read as deletions.
 */
export const SYNC_VERSION = 1;

/** A newer Aloud wrote the file: this one leaves it alone. */
export class NewerFileError extends Error {
  constructor() {
    super('The file in your Dropbox was written by a newer Aloud. Update Aloud on this device to keep syncing it.');
  }
}

/** One PDF's marks, by the hash of its bytes (pdf/annotations/store.ts). */
export interface SyncedMarks {
  name: string;
  marks: Mark[];
}

export interface SyncDoc {
  format: typeof SYNC_FORMAT;
  version: 1;
  notes: Note[];
  pdfMarks: Record<string, SyncedMarks>;
  /** Where the reader stopped, by document key (shared/position-match.ts). Absent in older files. */
  positions: PositionMap;
  /** What was listened to, by document key (shared/reading-history.ts). Absent in older files. */
  history: History;
  /** The settings that travel, by name (sync/synced-settings.ts), as of `settingsVersion`. */
  settings: SyncedSettings;
  settingsVersion: number;
  /**
   * The file's ancestry: an id for each of its last writes, oldest first. A device trusts what it
   * remembers of the file only if the write it last agreed with is among them, so the file now
   * descends from it. A file deleted and written anew, or restored from Dropbox's version history,
   * does not: it is merged keeping both sides, once, and nothing it lacks is read as deleted.
   */
  writes: string[];
}

/** Writes remembered in the file: a device offline for longer than this many keeps both sides once. */
export const MAX_WRITES = 5000;

export function emptyDoc(): SyncDoc {
  return {
    format: SYNC_FORMAT,
    version: 1,
    notes: [],
    pdfMarks: {},
    positions: {},
    history: {},
    settings: {},
    settingsVersion: SETTINGS_VERSION,
    writes: [],
  };
}

function newWriteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The file's settings, brought up to this version's shapes; only those that travel. */
function readSettings(raw: unknown, version: unknown): SyncedSettings {
  if (!raw || typeof raw !== 'object') return {};
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (e): e is [string, { v: unknown; at: number }] =>
      isSyncedSetting(e[0]) && !!e[1] && typeof e[1] === 'object' && 'v' in e[1] && typeof (e[1] as { at?: unknown }).at === 'number',
  );
  const from = typeof version === 'number' ? version : SETTINGS_VERSION;
  if (from >= SETTINGS_VERSION) return Object.fromEntries(entries.map(([k, e]) => [k, { v: e.v, at: e.at }]));
  // Written by an older Aloud: its values through the same migrations a stored profile goes through.
  const migrated = migrateSettings(Object.fromEntries(entries.map(([k, e]) => [k, e.v])), from);
  return Object.fromEntries(entries.filter(([k]) => k in migrated).map(([k, e]) => [k, { v: migrated[k], at: e.at }]));
}

/** The most recently read, as the device keeps them. */
function capHistory(history: History): History {
  const keys = Object.keys(history);
  if (keys.length <= MAX_HISTORY) return history;
  keys.sort((a, b) => history[b]!.lastReadAt - history[a]!.lastReadAt);
  return Object.fromEntries(keys.slice(0, MAX_HISTORY).map((k) => [k, history[k]!]));
}

/** The most recent ones, as the device keeps them. */
function capPositions(positions: PositionMap): PositionMap {
  const keys = Object.keys(positions);
  if (keys.length <= MAX_SAVED_POSITIONS) return positions;
  keys.sort((a, b) => positions[b]!.savedAt - positions[a]!.savedAt);
  return Object.fromEntries(keys.slice(0, MAX_SAVED_POSITIONS).map((k) => [k, positions[k]!]));
}

/** The file's text as a document; what is not a valid note or mark is left out. */
export function parseDoc(text: string): SyncDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file in your Dropbox is not one Aloud can read (aloud.json).');
  }
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (obj.format !== SYNC_FORMAT) throw new Error('The file in your Dropbox is not one Aloud can read (aloud.json).');
  if (typeof obj.version === 'number' && obj.version > SYNC_VERSION) throw new NewerFileError();
  const notes = Array.isArray(obj.notes) ? obj.notes.map((n) => normalizeNote(n)).filter((n): n is Note => !!n) : [];
  const pdfMarks: Record<string, SyncedMarks> = {};
  const marks = obj.pdfMarks && typeof obj.pdfMarks === 'object' ? (obj.pdfMarks as Record<string, unknown>) : {};
  for (const [hash, entry] of Object.entries(marks)) {
    if (!/^[0-9a-f]{16,128}$/.test(hash)) continue;
    const stored = normalizeStoredMarks({ updated: 0, ...(entry as object) });
    if (stored && stored.marks.length > 0) pdfMarks[hash] = { name: stored.name, marks: stored.marks as Mark[] };
  }
  const positions = capPositions(
    Object.fromEntries(Object.entries(recordsOf(obj.positions, normalizePosition)).filter(([key]) => key.length > 0)),
  );
  const history = capHistory(recordsOf(obj.history, normalizeHistoryEntry));
  const settings = readSettings(obj.settings, obj.settingsVersion);
  const writes = Array.isArray(obj.writes) ? obj.writes.filter((w): w is string => typeof w === 'string').slice(-MAX_WRITES) : [];
  return { format: SYNC_FORMAT, version: 1, notes: dedupe(notes), pdfMarks, positions, history, settings, settingsVersion: SETTINGS_VERSION, writes };
}

/** A note twice in one file (two devices' edits written in turn): its newest copy. */
function dedupe(notes: readonly Note[]): Note[] {
  const byId = new Map<string, Note>();
  for (const note of notes) {
    const seen = byId.get(note.id);
    if (!seen || note.updatedAt > seen.updatedAt) byId.set(note.id, note);
  }
  return [...byId.values()];
}

export function serializeDoc(doc: SyncDoc): string {
  return JSON.stringify(doc);
}

/** What the notes and marks are, names and order aside: to tell whether anything changed. */
export function contentOf(doc: SyncDoc): string {
  const marks = Object.fromEntries(Object.entries(doc.pdfMarks).map(([hash, entry]) => [hash, [...entry.marks].sort(byId)]));
  const settings = Object.fromEntries(Object.entries(doc.settings).map(([k, e]) => [k, e.v]));
  return canon({ notes: [...doc.notes].sort(byId), marks, positions: doc.positions, history: doc.history, settings });
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `current`'s changes since `baseline`, on top of `latest`. A null baseline: nothing agreed yet, keep both. */
export function mergeDocs(latest: SyncDoc, baseline: SyncDoc | null, current: SyncDoc, now = Date.now()): SyncDoc {
  const notes = reconcileById(latest.notes, baseline?.notes ?? [], current.notes, (n) => n.updatedAt ?? 0).sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  const pdfMarks: Record<string, SyncedMarks> = {};
  const hashes = new Set([...Object.keys(latest.pdfMarks), ...Object.keys(current.pdfMarks), ...Object.keys(baseline?.pdfMarks ?? {})]);
  for (const hash of [...hashes].sort()) {
    const there = latest.pdfMarks[hash];
    const here = current.pdfMarks[hash];
    const marks = reconcileById(there?.marks ?? [], baseline?.pdfMarks[hash]?.marks ?? [], here?.marks ?? [], (m) => m.updated ?? 0);
    if (marks.length === 0) continue;
    // The name the file already has: two devices that saved the PDF under different names would
    // otherwise take turns writing theirs.
    pdfMarks[hash] = { name: there?.name || here?.name || '', marks };
  }
  const positions = capPositions(reconcileMaps(latest.positions, baseline?.positions ?? {}, current.positions, (p) => p.savedAt));
  const history = capHistory(reconcileMaps(latest.history, baseline?.history ?? {}, current.history, (h) => h.lastReadAt));
  // No settings agreed yet (a new connection, or a device remembered from before settings were in
  // the file): this device joins, as synced-settings.ts mergeSettings says.
  const settingsBase = baseline && Object.keys(baseline.settings ?? {}).length > 0 ? baseline.settings : null;
  const settings = mergeSettings(latest.settings, settingsBase, current.settings, now);
  return {
    format: SYNC_FORMAT,
    version: 1,
    notes,
    pdfMarks,
    positions,
    history,
    settings,
    settingsVersion: SETTINGS_VERSION,
    writes: [...latest.writes],
  };
}

/** The file, as this device sees it. */
export interface RemoteFile {
  revision(): Promise<string | null>;
  download(): Promise<{ text: string; rev: string } | null>;
  upload(text: string, rev: string | null): Promise<string | 'conflict'>;
}

/** This device's notes and marks. */
export interface LocalData {
  read(): Promise<SyncDoc>;
  /**
   * Store `merged`; `seen` is what `read` gave at the start of the round, so changes made since stay.
   * Returns the settings it left as they were here for that reason.
   */
  write(merged: SyncDoc, seen: SyncDoc): Promise<{ keptSettings?: string[] } | void>;
}

export interface CloudStatus {
  at: number;
  notes?: number;
  pdfs?: number;
  /** Documents with a place to pick up at. */
  places?: number;
  error?: string;
}

interface CloudBook {
  /** The file's revision when this device last agreed with it. */
  rev: string | null;
  /** The file's content then. */
  base: SyncDoc | null;
  status: CloudStatus | null;
  /** The Dropbox account it belongs to: reconnecting the same one carries on from it. */
  accountId?: string;
}

const NOTHING: CloudBook = { rev: null, base: null, status: null };
const book = storage.defineItem<CloudBook>('local:cloudSync', { fallback: NOTHING });

export async function loadCloudStatus(): Promise<CloudStatus | null> {
  return (await book.getValue()).status;
}

export function watchCloudStatus(cb: (status: CloudStatus | null) => void): () => void {
  return book.watch((value) => cb(value?.status ?? null));
}

/**
 * Before a connection to `accountId`. The same account as before (reconnecting after its access
 * was taken back, say) carries on from what this device remembers, so what was deleted meanwhile
 * stays deleted; another account, or none remembered, starts by keeping both sides.
 */
export async function prepareCloudSync(accountId: string): Promise<void> {
  const was = await book.getValue();
  if (was.accountId && was.accountId === accountId) await book.setValue({ ...was, status: null });
  else await book.setValue({ ...NOTHING, accountId });
}

/** On disconnecting: the status goes, what the file was is kept for a reconnection (prepareCloudSync). */
export async function pauseCloudSync(): Promise<void> {
  const was = await book.getValue();
  await book.setValue({ ...was, status: null });
}

export async function setCloudError(error: string, now = Date.now()): Promise<void> {
  // Under the sync lock, as a round writes the book: never over a round's newer memory of the file.
  await withStorageLock('cloud-sync', async () => {
    const was = await book.getValue();
    await book.setValue({ ...was, status: { ...(was.status ?? { at: now }), at: now, error } });
  });
}

const ATTEMPTS = 3;

/**
 * One round. `reason: 'here'` is a change made on this device: when nothing differs from what was
 * last agreed, it ends without asking Dropbox anything (its own writes come back this way).
 */
export async function runCloudSync(remote: RemoteFile, local: LocalData, reason: 'here' | 'other', now = Date.now()): Promise<void> {
  await withStorageLock('cloud-sync', async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const stored = await book.getValue();
      // A file remembered by an earlier build lacks what later builds added (positions, history,
      // settings). Those parts are read as nothing agreed (empty: both sides kept), and the file
      // itself is downloaded, since what is remembered of it is not the whole of it.
      const partial = !!stored.base && (['positions', 'history', 'settings', 'writes'] as const).some((k) => !(k in stored.base!));
      const state = { ...stored, base: stored.base ? { ...emptyDoc(), ...stored.base } : null };
      const seen = await local.read();
      if (reason === 'here' && state.base && !partial && contentOf(seen) === contentOf(state.base)) return;

      const rev = await remote.revision();
      let latest: SyncDoc;
      let latestRev: string | null = rev;
      if (rev === null) {
        latest = emptyDoc();
      } else if (rev === state.rev && state.base && !partial) {
        latest = state.base; // as this device left it: nothing to download
      } else {
        const got = await remote.download();
        if (got) {
          latest = parseDoc(got.text);
          latestRev = got.rev;
        } else {
          latest = emptyDoc();
          latestRev = null;
        }
      }

      // What this device remembers holds only for a file that descends from it: not when there is
      // none, or it was written anew, or put back to an earlier write. Merging against it then would
      // read whatever the file lacks as deleted there, and delete it here.
      const agreedWrite = state.base?.writes.at(-1);
      const sameFile =
        latestRev !== null && !!state.base && (agreedWrite ? latest.writes.includes(agreedWrite) : latest.writes.length === 0);
      const merged = mergeDocs(latest, sameFile ? state.base : null, seen, now);
      let newRev = latestRev;
      if (latestRev === null || contentOf(merged) !== contentOf(latest)) {
        merged.writes = [...latest.writes, newWriteId()].slice(-MAX_WRITES);
        const written = await remote.upload(serializeDoc(merged), latestRev);
        if (written === 'conflict') continue;
        newRev = written;
      }
      const written = await local.write(merged, seen);
      // A setting changed here while the round ran kept its new value, and the file has the merged
      // one: remembered as it was here before the change (seen), so the next round merges the two
      // three ways. Remembered as merged, the next round read the other device's part of it (a
      // pronunciation it added) as removed here, and removed it everywhere.
      const kept = (written && written.keptSettings) || [];
      const remembered: SyncDoc =
        kept.length === 0
          ? merged
          : { ...merged, settings: { ...merged.settings, ...Object.fromEntries(kept.filter((k) => seen.settings[k]).map((k) => [k, seen.settings[k]!])) } };
      // Only over what this round started from: a round that outlived its lock (a frozen tab)
      // must not put back an older memory of the file after a newer round's.
      const current = await book.getValue();
      if (current.rev !== stored.rev) return;
      await book.setValue({
        ...current,
        // Altered as above, the memory is no longer the file at that revision: no revision, so the
        // next round downloads the file instead of taking the memory for it.
        rev: kept.length === 0 ? newRev : null,
        base: remembered,
        status: { at: now, notes: merged.notes.length, pdfs: Object.keys(merged.pdfMarks).length, places: Object.keys(merged.positions).length },
      });
      return;
    }
    throw new Error('Another device kept writing at the same moment. Aloud will try again shortly.');
  });
}
