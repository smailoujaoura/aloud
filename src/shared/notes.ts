/**
 * Notes: passages kept from what was being read, with the reader's own comments.
 *
 * One shortcut (or the bar's bookmark button) keeps the sentence being heard — or the selected
 * text — together with where it came from and where in the document it sits, so "listen from
 * here" can take the reader straight back to it. Kept in `storage.local`, on this device only.
 */
import { storage } from 'wxt/utils/storage';
import type { DocSource } from './doc-source';
import { sourceUrl } from './doc-source';
import type { TextAnchor } from '@/annotate/anchor';

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
  /** Highlight colour id (see annotate/colors.ts); absent means the default. */
  color?: string;
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

export type NotePatch = Partial<Pick<Note, 'text' | 'comment' | 'color' | 'tags'>>;

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

/** The notes as JSON, for moving them elsewhere or backing them up. */
export function notesToJson(notes: readonly Note[]): string {
  return JSON.stringify(
    notes.map((n) => ({
      text: n.text,
      comment: n.comment,
      tags: n.tags ?? [],
      color: n.color ?? null,
      title: n.source.title,
      site: n.source.site,
      url: sourceUrl(n.source),
      createdAt: new Date(n.createdAt).toISOString(),
      updatedAt: new Date(n.updatedAt).toISOString(),
    })),
    null,
    2,
  );
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

export async function addNote(entry: NewNote, now = Date.now()): Promise<{ note: Note; duplicate: boolean }> {
  const note: Note = { comment: '', ...entry, id: newId(), createdAt: now, updatedAt: now };
  const result = withNoteAdded(await loadNotes(), note);
  if (!result.duplicate) await item.setValue(result.notes);
  return { note: result.added, duplicate: result.duplicate };
}

export async function updateNote(id: string, patch: NotePatch): Promise<void> {
  await item.setValue(withNoteUpdated(await loadNotes(), id, patch));
}

export async function removeNote(id: string): Promise<void> {
  await item.setValue(withNoteRemoved(await loadNotes(), id));
}

/** Put a removed note back ("Undo"). */
export async function restoreNote(note: Note): Promise<void> {
  const notes = await loadNotes();
  if (notes.some((n) => n.id === note.id)) return;
  await item.setValue([note, ...notes].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_NOTES));
}

export function watchNotes(cb: (notes: Note[]) => void): () => void {
  return item.watch((value) => cb(value ?? []));
}
