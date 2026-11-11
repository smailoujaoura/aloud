/**
 * Notes, PDF marks and where the reader stopped in each document, kept in step between devices
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
import { normalizePosition, normalizeStoredMarks, recordsOf } from '@/shared/record-shapes';
import { MAX_SAVED_POSITIONS, type PositionMap } from '@/shared/position-match';
import type { Mark } from '@/pdf/annotations/model';

export const SYNC_FORMAT = 'aloud-sync';

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
}

export function emptyDoc(): SyncDoc {
  return { format: SYNC_FORMAT, version: 1, notes: [], pdfMarks: {}, positions: {} };
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
  const notes = Array.isArray(obj.notes) ? obj.notes.map((n) => normalizeNote(n)).filter((n): n is Note => !!n) : [];
  const pdfMarks: Record<string, SyncedMarks> = {};
  const marks = obj.pdfMarks && typeof obj.pdfMarks === 'object' ? (obj.pdfMarks as Record<string, unknown>) : {};
  for (const [hash, entry] of Object.entries(marks)) {
    if (!/^[0-9a-f]{16,128}$/.test(hash)) continue;
    const stored = normalizeStoredMarks({ updated: 0, ...(entry as object) });
    if (stored && stored.marks.length > 0) pdfMarks[hash] = { name: stored.name, marks: stored.marks as Mark[] };
  }
  const positions = capPositions(
    Object.fromEntries(Object.entries(recordsOf(obj.positions, normalizePosition)).filter(([key]) => key.length > 0 && key.length <= 4096)),
  );
  return { format: SYNC_FORMAT, version: 1, notes: dedupe(notes), pdfMarks, positions };
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
  return canon({ notes: [...doc.notes].sort(byId), marks, positions: doc.positions });
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `current`'s changes since `baseline`, on top of `latest`. A null baseline: nothing agreed yet, keep both. */
export function mergeDocs(latest: SyncDoc, baseline: SyncDoc | null, current: SyncDoc): SyncDoc {
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
  return { format: SYNC_FORMAT, version: 1, notes, pdfMarks, positions };
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
  /** Store `merged`; `seen` is what `read` gave at the start of the round, so changes made since stay. */
  write(merged: SyncDoc, seen: SyncDoc): Promise<void>;
}

export interface CloudStatus {
  at: number;
  notes?: number;
  pdfs?: number;
  error?: string;
}

interface CloudBook {
  /** The file's revision when this device last agreed with it. */
  rev: string | null;
  /** The file's content then. */
  base: SyncDoc | null;
  status: CloudStatus | null;
}

const NOTHING: CloudBook = { rev: null, base: null, status: null };
const book = storage.defineItem<CloudBook>('local:cloudSync', { fallback: NOTHING });

export async function loadCloudStatus(): Promise<CloudStatus | null> {
  return (await book.getValue()).status;
}

export function watchCloudStatus(cb: (status: CloudStatus | null) => void): () => void {
  return book.watch((value) => cb(value?.status ?? null));
}

/** Forget the file (on disconnecting): a later connection starts by keeping both sides. */
export async function forgetCloudSync(): Promise<void> {
  await book.setValue(NOTHING);
}

export async function setCloudError(error: string, now = Date.now()): Promise<void> {
  const was = await book.getValue();
  await book.setValue({ ...was, status: { ...(was.status ?? { at: now }), at: now, error } });
}

const ATTEMPTS = 3;

/**
 * One round. `reason: 'here'` is a change made on this device: when nothing differs from what was
 * last agreed, it ends without asking Dropbox anything (its own writes come back this way).
 */
export async function runCloudSync(remote: RemoteFile, local: LocalData, reason: 'here' | 'other', now = Date.now()): Promise<void> {
  await withStorageLock('cloud-sync', async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await book.getValue();
      const seen = await local.read();
      if (reason === 'here' && state.base && contentOf(seen) === contentOf(state.base)) return;

      const rev = await remote.revision();
      let latest: SyncDoc;
      let latestRev: string | null = rev;
      if (rev === null) {
        latest = emptyDoc();
      } else if (rev === state.rev && state.base) {
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

      // No file: nothing agreed with it any more. Merging against the old base would read every
      // note as deleted there.
      const merged = mergeDocs(latest, latestRev === null ? null : state.base, seen);
      let newRev = latestRev;
      if (latestRev === null || contentOf(merged) !== contentOf(latest)) {
        const written = await remote.upload(serializeDoc(merged), latestRev);
        if (written === 'conflict') continue;
        newRev = written;
      }
      await local.write(merged, seen);
      await book.setValue({
        rev: newRev,
        base: merged,
        status: { at: now, notes: merged.notes.length, pdfs: Object.keys(merged.pdfMarks).length },
      });
      return;
    }
    throw new Error('Another device kept writing at the same moment. Aloud will try again shortly.');
  });
}
