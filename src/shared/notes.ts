/**
 * Notes: passages kept from what was being read, with the reader's own comments.
 *
 * One shortcut (or the bar's bookmark button) keeps the sentence being heard — or the selected
 * text — together with where it came from and where in the document it sits, so "listen from
 * here" can take the reader straight back to it. Kept in `storage.local`, on this device only.
 */
import { storage } from 'wxt/utils/storage';
import type { DocSource } from './doc-source';
import { normalizeSource, sourceUrl } from './doc-source';
import type { TextAnchor } from '@/annotate/anchor';
import type { NoteStyle } from './settings';
import { withStorageLock } from './storage-lock';

export interface NotePosition {
  /** Playlist index of the sentence, and the playlist length then (see `position-match.ts`). */
  index: number;
  total: number;
  excerpt: string;
}

export interface Note {
  id: string;
  /** The passage, as it appears in the document. */
  text: string;
  /** What the reader wrote about it; empty until they do. */
  comment: string;
  source: DocSource;
  /** Where to resume to hear it again; null when it was saved without the reader running. */
  at: NotePosition | null;
  /**
   * The passage as a text quote, so it can be found and highlighted on the page again (see
   * annotate/anchor.ts). Absent for notes saved before highlighting existed, and for PDFs, whose
   * marks live in the PDF reader.
   */
  anchor?: TextAnchor;
  /** Colour id from the palette (see annotate/palette.ts); absent means the default. */
  color?: string;
  /** How it is marked on the page; absent means a highlight. */
  style?: NoteStyle;
  /** Your own labels ("rust-book", "exam"), lower-case. Absent in notes from before tags. */
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export type NewNote = Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'comment'> & { comment?: string };

/** Plenty for years of reading, while keeping one storage entry a sensible size. */
export const MAX_NOTES = 5000;
/** Pressing the shortcut twice on the same sentence keeps one note, not two. */
const DUPLICATE_WINDOW_MS = 2 * 60_000;

export function withNoteAdded(notes: readonly Note[], note: Note): { notes: Note[]; added: Note; duplicate: boolean } {
  const same = notes.find(
    (n) => n.source.key === note.source.key && n.text === note.text && Math.abs(note.createdAt - n.createdAt) < DUPLICATE_WINDOW_MS,
  );
  if (same) return { notes: [...notes], added: same, duplicate: true };
  // Newest first; the oldest fall off the end once the cap is reached.
  return { notes: [note, ...notes].slice(0, MAX_NOTES), added: note, duplicate: false };
}

export type NotePatch = Partial<Pick<Note, 'text' | 'comment' | 'color' | 'style' | 'tags'>>;

export function withNoteUpdated(notes: readonly Note[], id: string, patch: NotePatch, now = Date.now()): Note[] {
  return notes.map((n) => (n.id === id ? { ...n, ...patch, updatedAt: now } : n));
}

export function withNoteRemoved(notes: readonly Note[], id: string): Note[] {
  return notes.filter((n) => n.id !== id);
}

/** Notes matching every word of `query`, in the passage, the comment, the title, the site or a tag. */
export function searchNotes(notes: readonly Note[], query: string): Note[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...notes];
  return notes.filter((n) => {
    const haystack = `${n.text}\n${n.comment}\n${n.source.title}\n${n.source.site}\n${(n.tags ?? []).join(' ')}`.toLocaleLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

export interface NoteFilter {
  query?: string;
  /** A site as notes record it (`doc.rust-lang.org`); '' for all. */
  site?: string;
  /** A tag; '' for all. */
  tag?: string;
}

/** Search, narrowed to one site and/or one tag. */
export function filterNotes(notes: readonly Note[], filter: NoteFilter): Note[] {
  return searchNotes(notes, filter.query ?? '').filter(
    (n) => (!filter.site || n.source.site === filter.site) && (!filter.tag || (n.tags ?? []).includes(filter.tag)),
  );
}

/** Every site and tag in use, with how many notes each has, most-used first. */
export function noteFacets(notes: readonly Note[]): { sites: Array<[string, number]>; tags: Array<[string, number]> } {
  const sites = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const n of notes) {
    if (n.source.site) sites.set(n.source.site, (sites.get(n.source.site) ?? 0) + 1);
    for (const t of n.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  const order = (m: Map<string, number>): Array<[string, number]> => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { sites: order(sites), tags: order(tags) };
}

/** "Rust Book, exam ,, rust-book" -> ["rust-book", "exam"]: lower-case, trimmed, unique. */
export function parseTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(',')
        .map((t) => t.trim().toLocaleLowerCase().replace(/\s+/g, '-'))
        .filter(Boolean),
    ),
  ];
}

/** Notes on the page with document key `key`. */
export function notesForPage(notes: readonly Note[], key: string): Note[] {
  return notes.filter((n) => n.source.key === key);
}

export const NOTES_FILE_FORMAT = 'aloud-notes';

/**
 * The notes as a file that can be read back in (`parseNotesFile`): the whole records, so colours,
 * tags, anchors and where each came from survive the trip, with a readable `text`/`comment` in
 * every one for anything else that opens it.
 */
export function notesToFile(notes: readonly Note[], now = new Date()): string {
  return JSON.stringify({ format: NOTES_FILE_FORMAT, version: 1, exportedAt: now.toISOString(), notes }, null, 2);
}

/**
 * Notes from a file Aloud wrote: a notes file, a full backup, or a bare array of notes. Throws
 * with a readable message when it is none of those.
 */
export function parseNotesFile(text: string): Note[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not notes: it is not JSON.');
  }
  const holder = data as { notes?: unknown } | null;
  const list = Array.isArray(data) ? data : Array.isArray(holder?.notes) ? holder.notes : null;
  if (!list) throw new Error('No notes in that file.');
  const notes = list.map((n) => normalizeNote(n)).filter((n): n is Note => n != null);
  if (notes.length === 0) throw new Error('No notes in that file: none of its records had a passage and a page.');
  return notes;
}

/**
 * A note from a file, with everything the rest of Aloud assumes filled in — or null when there is
 * nothing usable in the record.
 *
 * What arrives from an import is the only data Aloud did not write itself. Accepting a record with
 * three of its fields and storing it put the Notes view into a state where drawing it threw, and
 * the only way out was clearing every note.
 */
export function normalizeNote(raw: unknown, now = Date.now()): Note | null {
  const note = raw as Partial<Note> | null;
  if (!note || typeof note !== 'object') return null;
  const text = typeof note.text === 'string' ? note.text.trim() : '';
  const source = normalizeSource(note.source);
  if (!text || !source) return null;
  const createdAt = Number.isFinite(note.createdAt) ? (note.createdAt as number) : now;
  const at =
    note.at && typeof note.at === 'object' && Number.isFinite(note.at.index) && Number.isFinite(note.at.total)
      ? { index: note.at.index, total: note.at.total, excerpt: String(note.at.excerpt ?? '') }
      : null;
  const anchor =
    note.anchor && typeof note.anchor === 'object' && typeof note.anchor.exact === 'string'
      ? {
          exact: note.anchor.exact,
          prefix: String(note.anchor.prefix ?? ''),
          suffix: String(note.anchor.suffix ?? ''),
          start: Number.isFinite(note.anchor.start) ? (note.anchor.start as number) : 0,
        }
      : undefined;
  return {
    id: typeof note.id === 'string' && note.id ? note.id : newId(),
    text,
    comment: typeof note.comment === 'string' ? note.comment : '',
    source,
    at,
    ...(anchor ? { anchor } : {}),
    ...(typeof note.color === 'string' ? { color: note.color } : {}),
    ...(note.style === 'underline' || note.style === 'highlight' ? { style: note.style } : {}),
    tags: Array.isArray(note.tags) ? note.tags.filter((t): t is string => typeof t === 'string') : [],
    createdAt,
    updatedAt: Number.isFinite(note.updatedAt) ? (note.updatedAt as number) : createdAt,
  };
}


/** Notes grouped by document, most recently noted document first, each group in reading order. */
export function groupBySource(notes: readonly Note[]): Array<{ source: DocSource; notes: Note[] }> {
  const groups = new Map<string, { source: DocSource; notes: Note[]; latest: number }>();
  for (const note of notes) {
    const group = groups.get(note.source.key) ?? { source: note.source, notes: [], latest: 0 };
    group.notes.push(note);
    group.latest = Math.max(group.latest, note.createdAt);
    groups.set(note.source.key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.latest - a.latest)
    .map(({ source, notes: list }) => ({
      source,
      notes: list.sort((a, b) => (a.at?.index ?? Infinity) - (b.at?.index ?? Infinity) || a.createdAt - b.createdAt),
    }));
}

/** Markdown for pasting into anything: a heading per document, a quote per note. */
export function notesToMarkdown(notes: readonly Note[]): string {
  const out: string[] = [];
  for (const { source, notes: list } of groupBySource(notes)) {
    const url = sourceUrl(source);
    out.push(`## ${source.title || source.site || 'Untitled'}`);
    if (url) out.push(`<${url}>`);
    out.push('');
    for (const note of list) {
      out.push(...note.text.replace(/\s+/g, ' ').trim().split('\n').map((line) => `> ${line}`));
      if (note.comment.trim()) out.push('', note.comment.trim());
      if (note.tags?.length) out.push('', note.tags.map((t) => `#${t}`).join(' '));
      out.push('');
    }
  }
  return out.join('\n').trim() + '\n';
}

// ---- storage ---------------------------------------------------------------------------------

const LOCK_KEY = 'notes';
const item = storage.defineItem<Note[]>('local:notes', { fallback: [] });

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadNotes(): Promise<Note[]> {
  try {
    return await item.getValue();
  } catch {
    return [];
  }
}

export interface NotesMerge {
  notes: Note[];
  /** Notes from `incoming` that are now kept and were not here before. */
  added: number;
  /** Notes here replaced by a newer copy from `incoming`. */
  updated: number;
  /** New notes from `incoming` left out because the cap was reached. */
  skipped: number;
}

/**
 * `here` plus `incoming`, the newer copy of each note winning — the one merge used by both the
 * notes import and a full restore.
 *
 * At the cap, notes already here outrank new ones from the file: an import must never be a way of
 * losing notes. Sorting everything and keeping the newest 5,000 silently deleted a kept note for
 * every one imported, while reporting success.
 */
export function mergeNoteLists(here: readonly Note[], incoming: readonly Note[]): NotesMerge {
  const byId = new Map(here.map((n) => [n.id, n]));
  const fresh: Note[] = [];
  let updated = 0;
  for (const note of incoming) {
    const have = byId.get(note.id);
    if (have) {
      if ((note.updatedAt ?? 0) > (have.updatedAt ?? 0)) {
        byId.set(note.id, note);
        updated++;
      }
    } else if (!fresh.some((f) => f.id === note.id)) {
      fresh.push(note);
    }
  }
  const room = Math.max(0, MAX_NOTES - byId.size);
  // Newest first when not all of them fit.
  const taken = [...fresh].sort((a, b) => b.createdAt - a.createdAt).slice(0, room);
  for (const note of taken) byId.set(note.id, note);
  return {
    notes: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt),
    added: taken.length,
    updated,
    skipped: fresh.length - taken.length,
  };
}

/** Add notes from a file, keeping the newer copy of anything already here. */
export async function mergeInNotes(incoming: readonly Note[]): Promise<{ added: number; updated: number; skipped: number }> {
  return withStorageLock(LOCK_KEY, async () => {
    const { notes, added, updated, skipped } = mergeNoteLists(await loadNotes(), incoming);
    if (added || updated) await item.setValue(notes);
    return { added, updated, skipped };
  });
}

export async function addNote(entry: NewNote, now = Date.now()): Promise<{ note: Note; duplicate: boolean }> {
  return withStorageLock(LOCK_KEY, async () => {
    const note: Note = { comment: '', ...entry, id: newId(), createdAt: now, updatedAt: now };
    const result = withNoteAdded(await loadNotes(), note);
    if (!result.duplicate) await item.setValue(result.notes);
    return { note: result.added, duplicate: result.duplicate };
  });
}

export async function updateNote(id: string, patch: NotePatch): Promise<void> {
  await withStorageLock(LOCK_KEY, async () => item.setValue(withNoteUpdated(await loadNotes(), id, patch)));
}

export async function removeNote(id: string): Promise<void> {
  await withStorageLock(LOCK_KEY, async () => item.setValue(withNoteRemoved(await loadNotes(), id)));
}

/** Put a removed note back ("Undo"). */
export async function restoreNote(note: Note): Promise<void> {
  await withStorageLock(LOCK_KEY, async () => {
    const notes = await loadNotes();
    if (notes.some((n) => n.id === note.id)) return;
    // Undo puts back what was just removed; it never pushes another note out to make room.
    if (notes.length >= MAX_NOTES) return;
    await item.setValue([note, ...notes].sort((a, b) => b.createdAt - a.createdAt));
  });
}

export function watchNotes(cb: (notes: Note[]) => void): () => void {
  return item.watch((value) => cb(value ?? []));
}
