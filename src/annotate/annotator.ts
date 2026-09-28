/**
 * Highlights and notes on ordinary web pages.
 *
 *  - **Select text** and press the shortcut: kept at once, in your default colour and style, with
 *    nothing to answer. (A small toolbar can also offer your colours and "Add note" on selecting;
 *    it can be switched off.) The passage is kept in Notes (shared/notes.ts) with a text anchor,
 *    so it is marked again whenever you come back.
 *  - **Click a mark** to change its colour or style (highlight / underline), write its note, tag,
 *    copy — or press Delete to remove it.
 *  - **The notes panel** lists this page's notes (or all of them) on the page itself.
 *  - **Single keys** (K to keep the selection, N for the panel) work wherever Aloud is running,
 *    since a browser shortcut can be taken by a browser menu and a page key cannot.
 *  - **Opened from the Library**, the page scrolls to the note and flashes it.
 *
 * Highlights are painted with the CSS Custom Highlight API, as the reader's sentence highlight is:
 * the page's DOM is never modified, so nothing about its layout or scripts can break. The toolbar
 * and popover live in one closed shadow root; no page style reaches them and none of theirs leaks.
 */
import { siteOf } from '@/shared/doc-source';
import { documentKey } from '@/shared/position-match';
import { addNote, loadNotes, notesForPage, parseTags, removeNote, restoreNote, updateNote, watchNotes, type Note } from '@/shared/notes';
import type { TextIndex } from '@/extract/text-index';
import { DEFAULT_ANNOTATE, getSettings, watchSettings, type AnnotateSettings, type NoteStyle } from '@/shared/settings';
import { anchorForRange, pageIndex, rangeForAnchor } from './page-anchoring';
import { isTypingEvent } from '@/media-speed/keys';
import { NOTE_STYLES, colorFor, markCss, markName } from './palette';
import { backgroundUnder, toneOf, type PageTone } from '@/highlight/contrast';
import { PANEL_CSS, PageNotesPanel } from './notes-panel';

const HOST_ID = 'aloud-annotate-host';
const READER_HOST_ID = 'aloud-control-host';
const FLASH = 'aloud-note-flash';

interface Painted {
  note: Note;
  range: Range;
}

export class PageAnnotator {
  private readonly key = documentKey(location.href);
  private notes: Note[] = [];
  private painted: Painted[] = [];
  private missing = 0;
  private index: TextIndex | null = null;
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private toolbar: HTMLElement | null = null;
  private popover: { el: HTMLElement; id: string } | null = null;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;
  private repaintTimer = 0;
  private repaints = 0;
  private observer: MutationObserver | null = null;
  private readonly cleanups: Array<() => void> = [];
  private readonly supported = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
  /** Colours, default colour and style, toolbar on/off (settings: annotate). */
  private prefs: AnnotateSettings = DEFAULT_ANNOTATE;
  /** Highlight names currently registered, so a removed colour's marks are cleared too. */
  private names = new Set<string>();
  private styleEl: HTMLStyleElement | null = null;
  /** Light or dark page: decides how strong the washes are (palette.ts: markCss). */
  private tone: PageTone = 'light';
  private panel: PageNotesPanel | null = null;
  private allNotes: Note[] = [];

  async start(): Promise<void> {
    this.prefs = (await getSettings().catch(() => null))?.annotate ?? DEFAULT_ANNOTATE;
    this.cleanups.push(
      watchSettings((s) => {
        this.prefs = s.annotate;
        this.injectStyle();
        this.paint();
        this.panel?.update(this.allNotes, this.prefs.colors);
      }),
    );
    this.injectStyle();
    this.allNotes = await loadNotes();
    this.notes = notesForPage(this.allNotes, this.key);
    this.paint();
    this.cleanups.push(
      watchNotes((all) => {
        this.allNotes = all;
        this.notes = notesForPage(all, this.key);
        this.paint();
        if (this.popover && !this.notes.some((n) => n.id === this.popover!.id)) this.closePopover();
        this.panel?.update(all, this.prefs.colors);
      }),
    );
    this.listen(document, 'mouseup', () => window.setTimeout(() => this.onSelection(), 10));
    this.listen(document, 'keyup', (e) => {
      if ((e as KeyboardEvent).shiftKey || (e as KeyboardEvent).key.startsWith('Arrow')) this.onSelection();
    });
    this.listen(document, 'click', (e) => this.onClick(e as MouseEvent), true);
    this.listen(document, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true);
    this.listen(document, 'keydown', (e) => {
      const key = e as KeyboardEvent;
      if (key.key === 'Escape') {
        this.closeToolbar();
        this.closePopover();
        this.panel?.close();
        return;
      }
      this.onPageKey(key);
    });
    this.listen(window, 'scroll', () => this.closeToolbar(), true);
    // Pages that fill in their content late (documentation sites, single-page apps) get another
    // try for highlights that were not found yet — a few times, not forever.
    this.observer = new MutationObserver(() => {
      if (this.missing === 0 || this.repaints >= 8) return;
      clearTimeout(this.repaintTimer);
      this.repaintTimer = window.setTimeout(() => {
        this.repaints++;
        this.paint();
      }, 800);
    });
    this.observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  stop(): void {
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    this.observer?.disconnect();
    clearTimeout(this.repaintTimer);
    if (this.supported) for (const name of this.names) CSS.highlights.delete(name);
    this.host?.remove();
  }

  /** How many of this page's notes are highlighted, and how many could not be found. */
  get counts(): { shown: number; missing: number } {
    return { shown: this.painted.length, missing: this.missing };
  }

  // ---- painting ---------------------------------------------------------------------

  private paint(): void {
    // A page that switched to its dark theme since the last paint gets washes to match.
    const view = document.defaultView;
    if (view && document.body && toneOf(backgroundUnder(document.body, view)) !== this.tone) this.injectStyle();
    this.index = pageIndex();
    this.painted = [];
    this.missing = 0;
    if (!this.index) return;
    for (const note of this.notes) {
      if (!note.anchor) continue;
      const range = rangeForAnchor(this.index, note.anchor);
      if (range) this.painted.push({ note, range });
      else this.missing++;
    }
    if (!this.supported) return;
    const groups = new Map<string, Range[]>();
    for (const { note, range } of this.painted) {
      const name = markName(colorFor(this.prefs.colors, note.color ?? this.prefs.defaultColor).id, note.style ?? 'highlight');
      groups.set(name, [...(groups.get(name) ?? []), range]);
    }
    for (const name of this.names) if (!groups.has(name)) CSS.highlights.delete(name);
    for (const [name, ranges] of groups) CSS.highlights.set(name, new Highlight(...ranges));
    this.names = new Set(groups.keys());
  }

  /** The marks' colours, redrawn whenever the palette changes. */
  private injectStyle(): void {
    if (!this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.id = 'aloud-annotate-style';
      (document.head ?? document.documentElement).append(this.styleEl);
      const el = this.styleEl;
      this.cleanups.push(() => el.remove());
    }
    const view = document.defaultView;
    if (view && document.body) this.tone = toneOf(backgroundUnder(document.body, view));
    this.styleEl.textContent = `${markCss(this.prefs.colors, this.tone)}\n::highlight(${FLASH}) { background-color: #ff8c00aa; color: inherit; }`;
  }

  // ---- making highlights ------------------------------------------------------------------

  private selectedRange(): Range | null {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement;
    if (!element || element.closest(`#${HOST_ID}, #${READER_HOST_ID}, input, textarea, [contenteditable="true"]`)) return null;
    return selection.toString().trim().length >= 2 ? range : null;
  }

  private onSelection(): void {
    if (!this.prefs.toolbar) return;
    const range = this.selectedRange();
    if (!range) {
      this.closeToolbar();
      return;
    }
    this.showToolbar(range.getBoundingClientRect());
  }

  /**
   * Keep the selection as a highlight (and a note), in the default colour and style unless told
   * otherwise — "Add note" uses the note colour, so notes stand out. Returns the note, or null if
   * nothing was selected.
   */
  async saveSelection(color?: string, openNote = false, style?: NoteStyle, quiet = false): Promise<Note | null> {
    const range = this.selectedRange();
    const index = pageIndex();
    if (!range || !index) {
      if (!quiet) this.toast('Select some text on the page first');
      return null;
    }
    const found = anchorForRange(index, range);
    if (!found) return null;
    const { note, duplicate } = await addNote({
      text: found.text,
      source: {
        key: this.key,
        title: document.title || location.hostname,
        site: siteOf(location.href),
        reopen: { kind: 'web', url: location.href },
      },
      at: null,
      anchor: found.anchor,
      color: color ?? (openNote ? this.prefs.noteColor : this.prefs.defaultColor),
      style: style ?? this.prefs.defaultStyle,
      tags: [],
    });
    document.getSelection()?.removeAllRanges();
    this.closeToolbar();
    this.toast(duplicate ? 'Already kept' : 'Kept in your Notes', duplicate ? undefined : { label: 'Undo', run: () => void removeNote(note.id) });
    if (openNote) window.setTimeout(() => this.openPopover(note.id, true), 60);
    return note;
  }

  // ---- editing highlights ------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const path = e.composedPath();
    if (this.host && path.includes(this.host)) return;
    this.closePopover();
  }

  private onClick(e: MouseEvent): void {
    if (e.button !== 0 || this.selectedRange()) return;
    const path = e.composedPath();
    if (this.host && path.includes(this.host)) return;
    if ((e.target as Element | null)?.closest?.('a, button, input, textarea, select, label')) return;
    const hit = this.highlightAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    this.openPopover(hit.note.id);
  }

  private highlightAt(x: number, y: number): Painted | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const pos = doc.caretPositionFromPoint?.(x, y);
    const range = pos ? null : doc.caretRangeFromPoint?.(x, y);
    const node = pos?.offsetNode ?? range?.startContainer;
    const offset = pos?.offset ?? range?.startOffset ?? 0;
    if (!node) return null;
    // Newest first, so the highlight on top is the one opened.
    for (const painted of [...this.painted].reverse()) {
      try {
        if (painted.range.isPointInRange(node, offset)) return painted;
      } catch {
        /* a node from another document */
      }
    }
    return null;
  }

  /** Scroll to a note's highlight and flash it — how the Library opens a note. */
  reveal(id: string): boolean {
    const painted = this.painted.find((p) => p.note.id === id);
    if (!painted) {
      const known = this.notes.some((n) => n.id === id);
      this.toast(known ? 'That passage is no longer on this page' : 'That note is not on this page');
      return false;
    }
    const box = painted.range.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, window.scrollY + box.top - window.innerHeight / 3), behavior: 'smooth' });
    if (this.supported) {
      CSS.highlights.set(FLASH, new Highlight(painted.range));
      window.setTimeout(() => CSS.highlights.delete(FLASH), 1800);
    }
    return true;
  }

  // ---- UI ---------------------------------------------------------------------------------

  private ui(): ShadowRoot {
    if (this.root) return this.root;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483645;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS + PANEL_CSS;
    root.append(style);
    (document.body ?? document.documentElement).append(host);
    this.host = host;
    this.root = root;
    this.cleanups.push(() => host.remove());
    return root;
  }

  private showToolbar(box: DOMRect): void {
    const root = this.ui();
    if (!this.toolbar) {
      const bar = document.createElement('div');
      bar.className = 'toolbar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Highlight the selection');
      for (const color of this.prefs.colors) {
        const swatch = button('', `Mark ${color.label}`, () => void this.saveSelection(color.id));
        swatch.className = 'swatch';
        swatch.style.setProperty('--c', color.fill);
        bar.append(swatch);
      }
      const other: NoteStyle = this.prefs.defaultStyle === 'underline' ? 'highlight' : 'underline';
      const styleBtn = button(other === 'underline' ? 'U' : 'H', other === 'underline' ? 'Underline instead' : 'Highlight instead', () =>
        void this.saveSelection(undefined, false, other),
      );
      styleBtn.className = `text-btn style-${other}`;
      const noteBtn = button('Add note', 'Keep it and write a note', () => void this.saveSelection(undefined, true));
      noteBtn.className = 'text-btn';
      bar.append(styleBtn, noteBtn);
      // Pressing a button must not clear the selection it acts on.
      bar.addEventListener('pointerdown', (e) => e.preventDefault());
      root.append(bar);
      this.toolbar = bar;
    }
    place(this.toolbar, box, 'above');
  }

  private closeToolbar(): void {
    this.toolbar?.remove();
    this.toolbar = null;
  }

  private openPopover(id: string, focusNote = false): void {
    this.closePopover();
    const painted = this.painted.find((p) => p.note.id === id);
    if (!painted) return;
    const note = painted.note;
    const root = this.ui();
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Highlight');

    const colors = document.createElement('div');
    colors.className = 'row';
    const current = colorFor(this.prefs.colors, note.color ?? this.prefs.defaultColor).id;
    for (const color of this.prefs.colors) {
      const swatch = button('', color.label, () => {
        void updateNote(note.id, { color: color.id });
        for (const s of colors.querySelectorAll('.swatch')) s.setAttribute('aria-pressed', String(s === swatch));
      });
      swatch.className = 'swatch';
      swatch.style.setProperty('--c', color.fill);
      swatch.setAttribute('aria-pressed', String(current === color.id));
      colors.append(swatch);
    }
    const styles = document.createElement('div');
    styles.className = 'seg';
    for (const style of NOTE_STYLES) {
      const b = button(style === 'highlight' ? 'Highlight' : 'Underline', `Mark it with ${style === 'highlight' ? 'a highlight' : 'an underline'}`, () => {
        void updateNote(note.id, { style });
        for (const s of styles.children) s.setAttribute('aria-pressed', String(s === b));
      });
      b.setAttribute('aria-pressed', String((note.style ?? 'highlight') === style));
      styles.append(b);
    }
    const spacer = document.createElement('span');
    spacer.className = 'grow';
    const copy = button('Copy', 'Copy the passage and your note', () => {
      const text = note.comment.trim() ? `${note.text}\n\n${note.comment.trim()}` : note.text;
      void navigator.clipboard.writeText(text).then(() => this.toast('Copied'), () => this.toast('Could not reach the clipboard'));
    });
    copy.className = 'text-btn';
    const remove = async (): Promise<void> => {
      this.closePopover();
      await removeNote(note.id);
      this.toast('Deleted', { label: 'Undo', run: () => void restoreNote(note) });
    };
    const del = button('Delete', 'Delete this mark and its note (Delete key)', () => void remove());
    del.className = 'text-btn danger';
    colors.append(spacer, copy, del);

    const comment = document.createElement('textarea');
    comment.placeholder = 'Your note…';
    comment.rows = 3;
    comment.value = note.comment;
    comment.setAttribute('aria-label', 'Your note');
    let timer = 0;
    comment.addEventListener('input', () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void updateNote(note.id, { comment: comment.value }), 400);
    });
    comment.addEventListener('blur', () => {
      clearTimeout(timer);
      if (comment.value !== note.comment) void updateNote(note.id, { comment: comment.value });
    });

    const tags = document.createElement('input');
    tags.placeholder = 'Tags, separated by commas';
    tags.value = (note.tags ?? []).join(', ');
    tags.setAttribute('aria-label', 'Tags');
    let tagTimer = 0;
    const saveTags = (): void => {
      clearTimeout(tagTimer);
      const next = parseTags(tags.value);
      if (next.join(',') !== (note.tags ?? []).join(',')) void updateNote(note.id, { tags: next });
    };
    tags.addEventListener('input', () => {
      clearTimeout(tagTimer);
      tagTimer = window.setTimeout(saveTags, 600);
    });
    tags.addEventListener('change', saveTags);
    tags.addEventListener('blur', saveTags);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Delete removes it · type to write a note · Esc closes';

    // Keys typed here belong to the note, not to the page's own shortcuts. The popover itself
    // takes focus, so Delete (or Backspace) removes the mark at once, and the first letter typed
    // moves into the note and carries on there.
    pop.tabIndex = -1;
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.target !== pop || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        void remove();
      } else if (e.key.length === 1) {
        comment.focus({ preventScroll: true });
        comment.setSelectionRange(comment.value.length, comment.value.length);
      }
    });
    pop.append(colors, styles, comment, tags, hint);
    root.append(pop);
    this.popover = { el: pop, id };
    place(pop, painted.range.getBoundingClientRect(), 'below');
    if (focusNote) comment.focus({ preventScroll: true });
    else pop.focus({ preventScroll: true });
  }

  /**
   * The single keys that work on pages Aloud is already running on (settings:
   * annotate.pageKeys). A browser shortcut can be swallowed by a browser menu; these cannot, and
   * they are as easy to hit as a key gets. Never while typing, never with a modifier, and "keep"
   * only when something is selected — so an ordinary letter stays an ordinary letter.
   */
  private onPageKey(e: KeyboardEvent): void {
    if (this.host && e.composedPath().includes(this.host)) return;
    const action = pageKeyAction(e, this.prefs.pageKeys, this.selectedRange() != null);
    if (!action) return;
    e.preventDefault();
    if (action === 'keep') void this.saveSelection();
    else this.togglePanel();
  }

  // ---- notes panel ------------------------------------------------------------------------

  /** Show (or hide) the list of notes on the page itself. */
  togglePanel(): void {
    if (this.panel?.isOpen) {
      this.panel.close();
      return;
    }
    this.closePopover();
    this.closeToolbar();
    this.panel ??= new PageNotesPanel(this.ui(), {
      pageKey: this.key,
      reveal: (id) => this.reveal(id),
      remove: async (note) => {
        await removeNote(note.id);
        this.toast('Deleted', { label: 'Undo', run: () => void restoreNote(note) });
      },
    });
    this.panel.open(this.allNotes, this.prefs.colors);
  }

  private closePopover(): void {
    const open = this.popover;
    if (!open) return;
    // Commit whatever is still being typed before the popover goes.
    open.el.querySelector('textarea')?.dispatchEvent(new Event('blur'));
    open.el.querySelector('input')?.dispatchEvent(new Event('blur'));
    open.el.remove();
    this.popover = null;
  }

  private toast(text: string, action?: { label: string; run: () => void }): void {
    const root = this.ui();
    this.toastEl?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.textContent = text;
    if (action) {
      const b = button(action.label, action.label, () => {
        toast.remove();
        action.run();
      });
      b.className = 'text-btn';
      toast.append(b);
    }
    root.append(toast);
    this.toastEl = toast;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.remove(), action ? 6000 : 2400);
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }
}

/**
 * What a key press on the page means: keep the selection, show the notes panel, or nothing.
 *
 * Nothing while typing, nothing with a modifier held (those are the browser's shortcuts), and
 * each key only in the state it makes sense in — so an ordinary letter stays an ordinary letter.
 */
export function pageKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'defaultPrevented'> & {
    target?: EventTarget | null;
    composedPath?: () => EventTarget[];
  },
  keys: { keep: string; panel: string },
  hasSelection: boolean,
): 'keep' | 'panel' | null {
  if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return null;
  // The composed path, not just the target: an input inside a shadow root retargets to its host,
  // and K would then be kept as a shortcut instead of typed into the box.
  if (isTypingEvent(e as unknown as Event)) return null;
  const key = e.key.toLowerCase();
  if (keys.keep && key === keys.keep.toLowerCase() && hasSelection) return 'keep';
  if (keys.panel && key === keys.panel.toLowerCase() && !hasSelection) return 'panel';
  return null;
}

function button(label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** Position a floating element next to a viewport box, kept on screen. */
function place(float: HTMLElement, box: DOMRect, side: 'above' | 'below'): void {
  float.style.visibility = 'hidden';
  float.style.left = '0px';
  float.style.top = '0px';
  const { width, height } = float.getBoundingClientRect();
  let top = side === 'above' ? box.top - height - 8 : box.bottom + 8;
  if (top < 8) top = box.bottom + 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, box.top - height - 8);
  const left = Math.min(Math.max(8, box.left + box.width / 2 - width / 2), window.innerWidth - width - 8);
  float.style.left = `${left}px`;
  float.style.top = `${top}px`;
  float.style.visibility = '';
}

export const UI_CSS = `
  :host { all: initial; }
  .toolbar, .popover, .toast {
    position: fixed; box-sizing: border-box;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #1b1b1f; background: #fff; border: 1px solid rgba(0,0,0,.14);
    border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
  }
  @media (prefers-color-scheme: dark) {
    .toolbar, .popover, .toast { color: #ececf1; background: #25252b; border-color: rgba(255,255,255,.14); }
    textarea, input { background: #1b1b20 !important; color: #ececf1 !important; border-color: rgba(255,255,255,.18) !important; }
  }
  .toolbar { display: flex; align-items: center; gap: 4px; padding: 5px; }
  button { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; border-radius: 8px; }
  .swatch { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; }
  .swatch::before { content: ''; width: 16px; height: 16px; border-radius: 50%; background: var(--c); box-shadow: inset 0 0 0 1px rgba(0,0,0,.2); }
  .swatch[aria-pressed='true']::before { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #888; }
  .swatch:hover, .text-btn:hover { background: rgba(127,127,127,.15); }
  .text-btn { padding: 5px 9px; font-weight: 600; }
  .danger { color: #c62828; }
  .popover { width: min(340px, calc(100vw - 16px)); padding: 8px; display: flex; flex-direction: column; gap: 6px; outline: none; }
  .popover:focus-visible { box-shadow: 0 0 0 2px #6b8afd, 0 6px 24px rgba(0,0,0,.18); }
  .seg { display: inline-flex; align-self: flex-start; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(127,127,127,.14); }
  .seg button { padding: 3px 10px; font-size: 12px; }
  .seg button[aria-pressed='true'] { background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); font-weight: 600; }
  @media (prefers-color-scheme: dark) { .seg button[aria-pressed='true'] { background: #3a3a44; } }
  .style-underline { text-decoration: underline 2px; text-underline-offset: 3px; }
  .hint { font-size: 11.5px; opacity: .6; }
  .row { display: flex; align-items: center; gap: 2px; }
  .grow { flex: 1; }
  textarea, input {
    box-sizing: border-box; width: 100%; font: inherit; padding: 7px 9px; border-radius: 8px;
    border: 1px solid rgba(0,0,0,.18); background: #fafafa; color: #1b1b1f; resize: vertical;
  }
  .toast { left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 12px; display: flex; align-items: center; gap: 8px; }
`;
