/**
 * The notes panel: your notes, on the page you are reading, without leaving it.
 *
 * A sheet at the side of the page (inside the annotator's closed shadow root) lists this page's
 * notes — or every note — newest first, with a search box. Clicking a note on this page scrolls
 * to it; one from another page opens that page at the passage. Delete removes the focused note
 * (with Undo), and the full Library is one link away for tags, export and editing at length.
 */
import { browser } from 'wxt/browser';
import { textFragmentUrl } from '@/annotate/anchor';
import { sourceUrl } from '@/shared/doc-source';
import { searchNotes, type Note } from '@/shared/notes';
import type { NoteColor } from '@/shared/settings';
import { colorFor, inkFor } from './palette';

export interface NotesPanelDeps {
  /** Document key of the page (shared/position-match.ts). */
  pageKey: string;
  /** Scroll to a note on this page; false when it is not found here. */
  reveal(id: string): boolean;
  remove(note: Note): Promise<void>;
}

type Scope = 'page' | 'all';

export class PageNotesPanel {
  private sheet: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private search: HTMLInputElement | null = null;
  private scopeButtons = new Map<Scope, HTMLButtonElement>();
  private notes: Note[] = [];
  private palette: NoteColor[] = [];
  private scope: Scope = 'page';
  private query = '';

  constructor(
    private readonly root: ShadowRoot,
    private readonly deps: NotesPanelDeps,
  ) {}

  get isOpen(): boolean {
    return this.sheet != null;
  }

  open(notes: Note[], palette: NoteColor[]): void {
    this.notes = notes;
    this.palette = palette;
    // Start on this page when it has notes; otherwise all of them, rather than an empty list.
    this.scope = notes.some((n) => n.source.key === this.deps.pageKey) ? 'page' : 'all';
    this.build();
    this.render();
    this.search?.focus({ preventScroll: true });
  }

  close(): void {
    this.sheet?.remove();
    this.sheet = null;
    this.list = null;
    this.search = null;
  }

  /** New notes or colours from storage, while open. */
  update(notes: Note[], palette: NoteColor[]): void {
    this.notes = notes;
    this.palette = palette;
    if (this.sheet) this.render();
  }

  private build(): void {
    this.close();
    const sheet = document.createElement('aside');
    sheet.className = 'notes-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Your notes');

    const head = document.createElement('div');
    head.className = 'sheet-head';
    const title = document.createElement('b');
    title.textContent = 'Notes';
    const scopes = document.createElement('div');
    scopes.className = 'seg';
    for (const [scope, label] of [
      ['page', 'This page'],
      ['all', 'All'],
    ] as Array<[Scope, string]>) {
      const b = mkButton(label, label === 'All' ? 'Every note you kept' : 'Notes on this page', () => {
        this.scope = scope;
        this.render();
      });
      this.scopeButtons.set(scope, b);
      scopes.append(b);
    }
    const close = mkButton('✕', 'Close (Esc)', () => this.close());
    close.className = 'text-btn';
    head.append(title, scopes, close);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search notes…';
    search.setAttribute('aria-label', 'Search notes');
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.render();
    });

    const list = document.createElement('ol');
    list.className = 'sheet-list';

    const foot = document.createElement('div');
    foot.className = 'sheet-foot';
    const library = mkButton('Open all notes in Aloud ↗', 'Tags, export and every note, in Aloud’s own page', () => {
      void browser.runtime.sendMessage({ type: 'open-library', tab: 'notes' }).catch(() => undefined);
    });
    library.className = 'text-btn';
    const keys = document.createElement('span');
    keys.className = 'hint';
    keys.textContent = 'Enter opens · Delete removes';
    foot.append(keys, library);

    // Keys here are the panel's, not the page's shortcuts.
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
        return;
      }
      e.stopPropagation();
      const item = (e.target as HTMLElement).closest?.('li[data-id]') as HTMLElement | null;
      if (!item) {
        if (e.key === 'ArrowDown' && e.target === search) {
          e.preventDefault();
          (list.querySelector('li[data-id]') as HTMLElement | null)?.focus();
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const next = (item.nextElementSibling ?? item.previousElementSibling) as HTMLElement | null;
        const note = this.notes.find((n) => n.id === item.dataset.id);
        if (note) void this.deps.remove(note).then(() => this.focusId(next?.dataset.id));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        item.click();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const to = (e.key === 'ArrowDown' ? item.nextElementSibling : item.previousElementSibling) as HTMLElement | null;
        (to ?? (e.key === 'ArrowUp' ? search : null))?.focus();
      }
    });

    sheet.append(head, search, list, foot);
    this.root.append(sheet);
    this.sheet = sheet;
    this.list = list;
    this.search = search;
  }

  private focusId(id: string | undefined): void {
    if (!id || !this.list) return;
    (this.list.querySelector(`li[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  }

  private render(): void {
    if (!this.list) return;
    const onPage = this.notes.filter((n) => n.source.key === this.deps.pageKey);
    const pool = this.scope === 'page' ? onPage : this.notes;
    const shown = searchNotes(pool, this.query).sort((a, b) => b.createdAt - a.createdAt);
    for (const [scope, b] of this.scopeButtons) {
      b.setAttribute('aria-pressed', String(scope === this.scope));
      b.textContent = `${scope === 'page' ? 'This page' : 'All'} ${scope === 'page' ? onPage.length : this.notes.length}`;
    }
    if (shown.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = this.query
        ? 'No notes match that search.'
        : this.scope === 'page'
          ? 'No notes on this page yet. Select text and press K to keep it.'
          : 'No notes yet.';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...shown.map((note) => this.item(note)));
  }

  private item(note: Note): HTMLElement {
    const li = document.createElement('li');
    li.dataset.id = note.id;
    li.tabIndex = 0;
    const color = colorFor(this.palette, note.color);
    li.style.setProperty('--c', note.style === 'underline' ? inkFor(color.fill) : color.fill);
    const text = document.createElement('p');
    text.className = 'quote';
    text.textContent = note.text;
    li.append(text);
    if (note.comment.trim()) {
      const comment = document.createElement('p');
      comment.className = 'comment';
      comment.textContent = note.comment.trim();
      li.append(comment);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const where = document.createElement('span');
    where.textContent = note.source.key === this.deps.pageKey ? 'On this page' : note.source.site || note.source.title;
    const del = mkButton('Delete', 'Delete this note (Delete key)', () => void this.deps.remove(note));
    del.className = 'text-btn danger';
    meta.append(where, del);
    li.append(meta);
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.go(note);
    });
    return li;
  }

  private go(note: Note): void {
    if (note.source.key === this.deps.pageKey && this.deps.reveal(note.id)) return;
    const url = sourceUrl(note.source);
    if (!url) return;
    const fragmentUrl = note.anchor ? textFragmentUrl(url, note.anchor) : url;
    // The background decides whether it may draw the highlights there (a site already granted)
    // or uses the browser's own text-fragment link.
    void browser.runtime.sendMessage({ type: 'open-note', id: note.id, url, fragmentUrl, checkAccess: true }).catch(() => undefined);
  }
}

function mkButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** The panel's styles, appended to the annotator's shadow stylesheet. */
export const PANEL_CSS = `
  .notes-sheet {
    position: fixed; top: 12px; right: 12px; bottom: 12px; width: min(360px, calc(100vw - 24px));
    display: flex; flex-direction: column; gap: 8px; padding: 10px; box-sizing: border-box;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1b1b1f; background: #fff; border: 1px solid rgba(0,0,0,.14); border-radius: 14px;
    box-shadow: 0 10px 40px rgba(0,0,0,.25);
  }
  @media (prefers-color-scheme: dark) { .notes-sheet { color: #ececf1; background: #25252b; border-color: rgba(255,255,255,.14); } }
  .sheet-head { display: flex; align-items: center; gap: 8px; }
  .sheet-head b { font-size: 15px; margin-right: auto; }
  .notes-sheet input[type='search'] { resize: none; }
  .sheet-list { list-style: none; margin: 0; padding: 0 2px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 6px; }
  .sheet-list li[data-id] {
    padding: 8px 10px 6px 12px; border-radius: 10px; cursor: pointer; outline: none;
    border: 1px solid rgba(127,127,127,.2); border-left: 4px solid var(--c);
  }
  .sheet-list li[data-id]:hover { background: rgba(127,127,127,.08); }
  .sheet-list li[data-id]:focus-visible { box-shadow: 0 0 0 2px #6b8afd; }
  .sheet-list .empty { opacity: .7; padding: 12px 4px; }
  .quote { margin: 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .comment { margin: 4px 0 0; font-style: italic; opacity: .85; }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 4px; font-size: 12px; opacity: .75; }
  .meta .text-btn { padding: 2px 6px; font-weight: 500; }
  .sheet-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
`;
