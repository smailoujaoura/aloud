/**
 * The notes panel: your notes, on the page you are reading, without leaving it.
 *
 * A sheet at the side of the page (inside the annotator's closed shadow root) lists this page's
 * notes — or every note — newest first, with a search box. Clicking a note on this page scrolls
 * to it; one from another page opens that page at the passage. Delete removes the focused note
 * (with Undo), and the full Library is one link away for tags, export and editing at length.
 *
 * It can be moved: dragged by its header, with the mouse or a finger, anywhere in the window, and
 * it opens there from then on, on every site (panel-place.ts has the arithmetic). A double-click
 * on the header puts it back at the side. On a phone-width window it fills the window from side to
 * side already, so there it stays the sheet it opens as.
 */
import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import { textFragmentUrl } from '@/annotate/anchor';
import { sourceUrl } from '@/shared/doc-source';
import { searchNotes, type Note } from '@/shared/notes';
import type { NoteColor } from '@/shared/settings';
import { withStorageLock } from '@/shared/storage-lock';
import { READING_ATTR, colorFor, inkFor } from './palette';
import { NARROW_WIDTH, clearOfBar, findBox, movedHeight, placePanel, spotOfPanel, validSpot, type Box, type PanelSpot, type Size } from './panel-place';

export interface NotesPanelDeps {
  /** Document key of the page (shared/position-match.ts). */
  pageKey: string;
  /** Scroll to a note on this page; false when it is not found here. */
  reveal(id: string): boolean;
  remove(note: Note): Promise<void>;
}

type Scope = 'page' | 'all';

/** The reading bar's shadow host (ui/control-bar.ts). */
const BAR_HOST_ID = 'aloud-control-host';
/** How far a press must move before it is a drag rather than a click, as on the video speed button. */
const DRAG_PX = 8;
/** Shown on the header wherever the panel can be moved. */
const MOVE_TIP = 'Drag to move. Double-click to put it back at the side.';

/**
 * Where the reader moved the panel. One place for every site: the panel is Aloud's own, not part
 * of the page, and a reader who wants it on the left wants it there everywhere. Kept on this
 * device only (storage.local, never synced): another device's window is another shape.
 */
const spotItem = storage.defineItem<PanelSpot | null>('local:notesPanelSpot', { fallback: null });

async function loadSpot(): Promise<PanelSpot | null> {
  try {
    return validSpot(await spotItem.getValue());
  } catch {
    return null;
  }
}

/** Remember `spot`, or forget it (null: back at the side). */
async function saveSpot(spot: PanelSpot | null): Promise<void> {
  try {
    await withStorageLock('notes-panel-spot', () => (spot ? spotItem.setValue(spot) : spotItem.removeValue()));
  } catch {
    /* best-effort: it opens at the side next time */
  }
}

export class PageNotesPanel {
  private sheet: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private search: HTMLInputElement | null = null;
  private scopeButtons = new Map<Scope, HTMLButtonElement>();
  private notes: Note[] = [];
  private palette: NoteColor[] = [];
  private scope: Scope = 'page';
  private query = '';
  /** Keeps the sheet clear of the reading bar while Aloud reads (see `aboveBar`). */
  private readingWatch: MutationObserver | null = null;
  private head: HTMLElement | null = null;
  /** Where the reader put the panel; null until they move it, and once a double-click puts it back. */
  private spot: PanelSpot | null = null;
  /** The stored spot has been read at least once (until then the panel is not shown where it might jump from). */
  private spotRead = false;
  private dragging = false;
  /** A drag ends in a click on whatever it ended over: not a click, so not acted on. */
  private ignoreClicksUntil = 0;
  /**
   * The reading bar's box, as last found. Kept while the bar is tucked away out of sight (it can
   * hide while the page scrolls), so a panel moved meanwhile still stays clear of where it comes
   * back. Forgotten when reading starts or stops, and when the window is resized.
   */
  private barSeen: Box | null = null;
  /** Undone when the panel closes: its listeners on the window and on storage, and its timers. */
  private readonly whileOpen: Array<() => void> = [];

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
    this.layout();
    this.search?.focus({ preventScroll: true });
    const sheet = this.sheet;
    // Read again at every opening: it may have been moved in another tab since. The first time,
    // the panel waits unseen (still focusable, so the search box keeps the keys) rather than
    // showing at the side and then jumping to where it was put.
    if (!this.spotRead) sheet?.classList.add('placing');
    void loadSpot().then((spot) => {
      this.spotRead = true;
      if (this.sheet !== sheet || this.dragging) return;
      this.spot = spot;
      sheet?.classList.remove('placing');
      this.layout();
    });
  }

  close(): void {
    this.readingWatch?.disconnect();
    this.readingWatch = null;
    for (const off of this.whileOpen.splice(0)) off();
    this.dragging = false;
    this.sheet?.remove();
    this.sheet = null;
    this.head = null;
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
    // The reading bar is docked at the bottom of the window (or the top), above everything: the
    // sheet's foot (or head) would sit under it. Stop short of the bar for as long as Aloud reads.
    const aboveBar = (): void => {
      const edge = document.documentElement.getAttribute(READING_ATTR);
      sheet.classList.toggle('above-bar', edge != null && edge !== 'top');
      sheet.classList.toggle('below-bar', edge === 'top');
    };
    aboveBar();
    // A panel the reader moved is kept clear of the bar where the bar actually is (see `layout`).
    // Looked at again a moment later too: the bar settles into one row or two once it has measured
    // itself, and is a little taller or shorter than it was drawn at first.
    let settle = 0;
    this.readingWatch = new MutationObserver(() => {
      aboveBar();
      this.barSeen = null;
      this.layout();
      clearTimeout(settle);
      settle = window.setTimeout(() => this.layout(), 400);
    });
    this.readingWatch.observe(document.documentElement, { attributes: true, attributeFilter: [READING_ATTR] });
    // Kept inside a window made smaller, and where it was put across one made bigger. The bar is
    // looked for again once the resizing stops: it is centred on the window, so it moved too.
    let resized = 0;
    const onResize = (): void => {
      this.layout(false);
      clearTimeout(resized);
      resized = window.setTimeout(() => {
        this.barSeen = null;
        this.layout();
      }, 200);
    };
    window.addEventListener('resize', onResize);
    this.whileOpen.push(() => {
      window.removeEventListener('resize', onResize);
      clearTimeout(resized);
      clearTimeout(settle);
    });
    // Moved in another tab while open here: follow it.
    this.whileOpen.push(
      spotItem.watch((value) => {
        if (this.dragging) return;
        this.spot = validSpot(value);
        this.layout();
      }),
    );

    const head = document.createElement('div');
    head.className = 'sheet-head';
    this.head = head;
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
    this.draggable(head);
    this.sheet = sheet;
    this.list = list;
    this.search = search;
  }

  /**
   * Where the panel is drawn. At the side (the stylesheet's own layout) until the reader moves it,
   * and always on a phone-width window; once moved, at the spot they put it, kept inside the
   * window and, unless it is being dragged, off the reading bar. `probe` false keeps to the bar's
   * box as last found, without looking for it again (while the window is being resized).
   */
  private layout(probe = true): void {
    const sheet = this.sheet;
    const head = this.head;
    if (!sheet || !head) return;
    const view = viewSize();
    const movable = view.width > NARROW_WIDTH;
    sheet.classList.toggle('movable', movable);
    head.title = movable ? MOVE_TIP : '';
    const spot = movable ? this.spot : null;
    sheet.classList.toggle('moved', spot != null);
    if (!spot) {
      for (const prop of ['left', 'top', 'height']) sheet.style.removeProperty(prop);
      return;
    }
    const size = { width: sheet.getBoundingClientRect().width, height: movedHeight(view) };
    const at = placePanel(spot, size, view);
    let box: Box = { ...at, ...size };
    // Not while dragged: it follows the pointer, over the bar too, and is moved off it when let go.
    if (!this.dragging) box = clearOfBar(box, this.readingBar(box, view, probe), view);
    sheet.style.left = `${box.left}px`;
    sheet.style.top = `${box.top}px`;
    sheet.style.height = `${box.height}px`;
  }

  /**
   * The reading bar's box while Aloud reads, or null when it is not reading. The bar is drawn in its
   * own closed shadow root, so it is found where it is on screen (`findBox`): first over the panel
   * itself, which is all that matters when it is in view, and else over the whole window once, so
   * a bar that has slid out of sight is still known by where it was. Never seen at all (it was
   * hidden before the panel opened), it is taken to be where it opens, along the bottom, as the
   * side sheet takes it to be.
   */
  private readingBar(panel: Box, view: Size, probe: boolean): Box | null {
    const reading = document.documentElement.hasAttribute(READING_ATTR);
    const host = document.getElementById(BAR_HOST_ID);
    if (!host && !reading) {
      this.barSeen = null;
      return null;
    }
    if (host && probe && typeof document.elementFromPoint === 'function') {
      // The topmost thing at a point is enough: the bar is drawn above everything on the page,
      // the notes panel included.
      const hit = (x: number, y: number): boolean => document.elementFromPoint(x, y) === host;
      const found =
        findBox(panel, { x: 48, y: 16 }, view, hit) ??
        (this.barSeen ? null : findBox({ left: 0, top: 0, ...view }, { x: 64, y: 16 }, view, hit));
      // The small handle left at the edge while the bar is hidden is not the bar.
      if (found && found.height >= 32) this.barSeen = found;
    }
    return this.barSeen ?? (reading ? { left: 0, top: view.height - 84, width: view.width, height: 84 } : null);
  }

  /**
   * Moved by dragging its header, with a finger or the mouse (the video speed button's way,
   * media-speed/touch-button.ts). A press that moves less than DRAG_PX is a click, left to the
   * header's buttons; past that it is a drag, and the click it ends in is not acted on.
   */
  private draggable(head: HTMLElement): void {
    let drag: { id: number; x: number; y: number; left: number; top: number; moving: boolean } | null = null;
    // The header itself is not selectable, but in WebKit (Safari) a press on it started a selection
    // in the panel around it, and the drag then selected the page's text all along the way. No
    // selection starts, in the panel or the page, while the header is held.
    const noSelecting = (e: Event): void => e.preventDefault();
    const unlisten = (): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      document.removeEventListener('selectstart', noSelecting, true);
      this.root.removeEventListener('selectstart', noSelecting, true);
    };
    // Followed on the whole window from the press: a quick flick's first move is already off the
    // header, and the header alone never heard it, so the drag was lost.
    const move = (ev: Event): void => {
      const e = ev as PointerEvent;
      const sheet = this.sheet;
      if (!drag || e.pointerId !== drag.id || !sheet) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moving) {
        if (Math.hypot(dx, dy) < DRAG_PX) return;
        drag.moving = true;
        this.dragging = true;
        sheet.classList.add('dragging');
        // Only now: captured from the press, a plain click's target was the header, not its button.
        try {
          head.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
      }
      const view = viewSize();
      const size = { width: sheet.getBoundingClientRect().width, height: movedHeight(view) };
      this.spot = spotOfPanel(drag.left + dx, drag.top + dy, size, view);
      this.layout();
    };
    const end = (ev: Event): void => {
      const e = ev as PointerEvent;
      if (!drag || e.pointerId !== drag.id) return;
      const moved = drag.moving;
      drag = null;
      unlisten();
      this.dragging = false;
      this.sheet?.classList.remove('dragging');
      if (!moved) return;
      this.ignoreClicksUntil = performance.now() + 400;
      // Where it was let go is what is kept, even over the bar: it is only moved off the bar for
      // as long as the bar is there.
      this.layout();
      void saveSpot(this.spot);
    };
    head.addEventListener('pointerdown', (e) => {
      const sheet = this.sheet;
      if (!sheet?.classList.contains('movable') || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const r = sheet.getBoundingClientRect();
      // From where it is drawn: the side sheet's corner, or moved off the bar, not the spot kept.
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moving: false };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', end, true);
      window.addEventListener('pointercancel', end, true);
      document.addEventListener('selectstart', noSelecting, true);
      this.root.addEventListener('selectstart', noSelecting, true);
    });
    this.whileOpen.push(() => {
      drag = null;
      unlisten();
    });
    // Before the buttons hear it.
    head.addEventListener(
      'click',
      (e) => {
        if (performance.now() >= this.ignoreClicksUntil) return;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    // Back at the side, where it opens until moved. Not from a double-click on its buttons: that is
    // two clicks on "All", say.
    head.addEventListener('dblclick', (e) => {
      if (!this.sheet?.classList.contains('movable') || (e.target as HTMLElement).closest?.('button')) return;
      if (performance.now() < this.ignoreClicksUntil || !this.spot) return;
      this.spot = null;
      this.layout();
      void saveSpot(null);
    });
    // The drag is the panel's: a page that drags things of its own, or closes a menu when the
    // mouse is let go, does not see it.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchmove', 'touchend']) {
      head.addEventListener(type, (e) => e.stopPropagation());
    }
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

const viewSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

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
  .notes-sheet.above-bar { bottom: 92px; }
  /* Under a bar docked at the top: the bar is taller on a phone, and a notch adds to it. */
  .notes-sheet.below-bar { top: calc(env(safe-area-inset-top, 0px) + 92px); }
  @media (max-width: 600px) { .notes-sheet.below-bar { top: calc(env(safe-area-inset-top, 0px) + 150px); } }
  /* Moved by the reader: placed by its own left, top and height (notes-panel.ts: layout). */
  .notes-sheet.moved { right: auto; bottom: auto; }
  .notes-sheet.placing { opacity: 0; }
  .notes-sheet.dragging { box-shadow: 0 16px 50px rgba(0,0,0,.32); }
  /* A finger on the header moves the panel, not the page, and the title is not selected as it goes. */
  .notes-sheet.movable .sheet-head { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
  .notes-sheet.dragging .sheet-head { cursor: grabbing; }
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
