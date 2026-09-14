/**
 * Highlighting, underlining, striking through and commenting on a PDF in the page view.
 *
 *  - **Select text** and a small toolbar appears over it: a colour to highlight in, underline,
 *    strike through, or add a note. Each has a key (H, U, S, N, and 1–4 for the colours).
 *  - **Click a mark** to change its colour or kind, write a note on it, or delete it.
 *  - **Notes** lists every mark in reading order and jumps to one.
 *  - **Save** writes the marks into the PDF file itself (see `save-file.ts` for what each browser
 *    allows). Every change is also kept on this device as it happens, file or no file.
 *
 * Marks are drawn in a layer between the page image and the invisible text layer, so selecting
 * text, the reader's sentence highlight and tap-to-seek all keep working over them.
 */
import {
  MARK_COLORS,
  MarkHistory,
  inReadingOrder,
  markAt,
  mergeLineBoxes,
  newMarkId,
  paletteOf,
  recolorForKind,
  toneFor,
  unionBox,
  type Box,
  type Mark,
  type MarkKind,
} from './model';
import type { PdfPageView } from '../load-pdf';
import { svgIcon } from '@/shared/dom';
import type { SaveMode } from './save-file';

export interface EditorPage {
  pageNumber: number;
  holder: HTMLElement;
  view: PdfPageView;
}

export interface EditorOptions {
  pages: EditorPage[];
  marks: Mark[];
  /** Marks as they are in the file, to tell whether there is anything unsaved. */
  savedMarks: readonly Mark[];
  saveMode: SaveMode;
  fileName: string;
  /** Every change, straight away — the caller keeps it on this device. */
  onChange(marks: readonly Mark[]): void;
  /** Write the marks into the file. Resolves to a message for the toolbar, or null if cancelled. */
  onSave(marks: readonly Mark[]): Promise<{ message: string; saveMode: SaveMode } | null>;
}

const KIND_LABEL: Record<MarkKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'Strike through',
  note: 'Note',
};

const KIND_KEY: Record<string, MarkKind> = { h: 'highlight', u: 'underline', s: 'strike' };

const SAVE_LABEL: Record<SaveMode, { label: string; title: string }> = {
  'in-place': { label: 'Save', title: 'Write the marks into the PDF file (Ctrl+S)' },
  'save-as': { label: 'Save…', title: 'Choose where to save — pick the original file to replace it (Ctrl+S)' },
  'download-as': { label: 'Save…', title: 'Choose where to save — pick the original file to replace it (Ctrl+S)' },
  download: { label: 'Save a copy', title: 'Download the PDF with its marks (Ctrl+S)' },
};

const LAST_COLOR_KEY = 'aloud.markColor';

export class MarkEditor {
  private readonly history: MarkHistory;
  private readonly pages = new Map<number, EditorPage>();
  private readonly layers = new Map<number, { marks: HTMLElement; pins: HTMLElement }>();
  private colorId = readLastColor();
  private savedSignature: string;
  private saveMode: SaveMode;
  private saving = false;

  private readonly tools: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly notesBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private selectionBar: HTMLElement | null = null;
  private popover: { el: HTMLElement; id: string } | null = null;
  private panel: HTMLElement | null = null;
  /** The mark whose note is being typed into, so a run of keystrokes is one undo step. */
  private typingInto: string | null = null;
  private readonly cleanups: Array<() => void> = [];
  private selectionTimer = 0;

  constructor(private readonly opts: EditorOptions) {
    for (const page of opts.pages) this.pages.set(page.pageNumber, page);
    this.history = new MarkHistory(opts.marks);
    this.savedSignature = signature(opts.savedMarks);
    this.saveMode = opts.saveMode;

    // ---- document toolbar ----
    this.tools = el('div', { class: 'doc-tools', role: 'toolbar', 'aria-label': 'Annotations' });
    this.undoBtn = button('Undo', () => this.undo(), 'Undo (Ctrl+Z)', 'icon-btn');
    this.undoBtn.append(svgIcon(document, UNDO_SVG));
    this.undoBtn.setAttribute('aria-label', 'Undo');
    this.redoBtn = button('Redo', () => this.redo(), 'Redo (Ctrl+Shift+Z)', 'icon-btn');
    this.redoBtn.append(svgIcon(document, REDO_SVG));
    this.redoBtn.setAttribute('aria-label', 'Redo');
    this.notesBtn = button('Notes', () => this.togglePanel(), 'Every highlight and note in this PDF');
    this.notesBtn.setAttribute('aria-haspopup', 'dialog');
    this.status = el('span', { class: 'doc-status', role: 'status', 'aria-live': 'polite' });
    this.saveBtn = button('Save', () => void this.save(), '', 'primary');
    this.tools.append(this.undoBtn, this.redoBtn, el('span', { class: 'tools-sep' }), this.notesBtn, this.status, this.saveBtn);
    document.body.append(this.tools);

    for (const page of opts.pages) this.ensureLayers(page);
    this.redraw();
    this.fillMissingText();

    this.listen(document, 'selectionchange', () => this.onSelectionChange());
    this.listen(document, 'pointerup', () => this.onSelectionChange(0));
    this.listen(document, 'keydown', (e) => this.onKey(e as KeyboardEvent));
    // Capture, and registered before the reader starts: a click on a mark opens it rather than
    // also making the reader jump to that sentence (tap-to-seek ignores prevented clicks).
    this.listen(document, 'click', (e) => this.onClick(e as MouseEvent), true);
    this.listen(document, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true);
    this.listen(window, 'resize', () => this.closeSelectionBar());
  }

  get marks(): readonly Mark[] {
    return this.history.marks;
  }

  dispose(): void {
    clearTimeout(this.selectionTimer);
    for (const off of this.cleanups) off();
    this.closeSelectionBar();
    this.closePopover();
    this.closePanel();
    this.tools.remove();
    for (const { marks, pins } of this.layers.values()) {
      marks.remove();
      pins.remove();
    }
  }

  // ---- drawing -----------------------------------------------------------------

  private ensureLayers(page: EditorPage): { marks: HTMLElement; pins: HTMLElement } {
    let layers = this.layers.get(page.pageNumber);
    if (layers) return layers;
    const marks = el('div', { class: 'mark-layer', 'aria-hidden': 'true' });
    const pins = el('div', { class: 'pin-layer' });
    const textLayer = page.holder.querySelector('.text-layer');
    page.holder.insertBefore(marks, textLayer);
    page.holder.append(pins);
    layers = { marks, pins };
    this.layers.set(page.pageNumber, layers);
    return layers;
  }

  private redraw(): void {
    for (const { marks, pins } of this.layers.values()) {
      marks.replaceChildren();
      pins.replaceChildren();
    }
    for (const mark of this.history.marks) this.draw(mark);

    this.undoBtn.disabled = !this.history.canUndo;
    this.redoBtn.disabled = !this.history.canRedo;
    const count = this.history.marks.length;
    this.notesBtn.textContent = count ? `Notes · ${count}` : 'Notes';
    const unsaved = signature(this.history.marks) !== this.savedSignature;
    const { label, title } = SAVE_LABEL[this.saveMode];
    this.saveBtn.textContent = label;
    this.saveBtn.title = title;
    this.saveBtn.disabled = this.saving;
    this.saveBtn.classList.toggle('unsaved', unsaved);
    if (!this.saving && !this.status.classList.contains('flash')) this.status.textContent = unsaved ? 'Not in the file yet' : count ? 'Saved in the file' : '';
    if (this.panel) this.renderPanel(this.panel);
  }

  private draw(mark: Mark): void {
    const page = this.pages.get(mark.page);
    const layers = page && this.layers.get(mark.page);
    if (!page || !layers) return;
    const selected = this.popover?.id === mark.id;

    if (mark.kind === 'note') {
      const [left, top, width, height] = toCss(page.view, mark.boxes[0]!);
      const pin = this.pin(mark, left + width / 2 - 11, top + height / 2 - 11);
      layers.pins.append(pin);
      return;
    }

    for (const box of mark.boxes) {
      const [left, top, width, height] = toCss(page.view, box);
      const part = el('div', { class: `mark ${mark.kind}${selected ? ' selected' : ''}` });
      part.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;--mark:${mark.color}`;
      layers.marks.append(part);
    }
    if (mark.note) {
      const [left, top, width] = toCss(page.view, mark.boxes[0]!);
      layers.pins.append(this.pin(mark, left + width - 4, top - 14));
    }
  }

  /** The speech-bubble button for a mark with a note (or a free-standing note). */
  private pin(mark: Mark, left: number, top: number): HTMLElement {
    const pin = button('', () => this.openPopover(mark.id), mark.note || 'Note', 'pin');
    pin.append(svgIcon(document, NOTE_SVG));
    pin.setAttribute('aria-label', mark.note ? `Note: ${mark.note}` : 'Empty note');
    pin.style.cssText = `left:${left}px;top:${top}px;--mark:${paletteOf(mark.color)?.fill ?? mark.color}`;
    return pin;
  }

  /** Marks that came from the file have no text; find what they cover in the text layer. */
  private fillMissingText(): void {
    for (const mark of this.history.marks) {
      if (mark.text || mark.kind === 'note') continue;
      const page = this.pages.get(mark.page);
      if (!page) continue;
      const text = textUnder(page, mark.boxes);
      if (text) this.history.amend(mark.id, { text }, mark.updated);
    }
  }

  // ---- making marks ----------------------------------------------------------------

  private onSelectionChange(delay = 120): void {
    clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => {
      const found = selectedText(this.pages);
      if (found.length === 0) this.closeSelectionBar();
      else this.showSelectionBar();
    }, delay);
  }

  private showSelectionBar(): void {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    if (!this.selectionBar) {
      const bar = el('div', { class: 'sel-bar', role: 'toolbar', 'aria-label': 'Mark the selected text' });
      MARK_COLORS.forEach((color, i) => {
        const swatch = button('', () => this.markSelection('highlight', color.id), `Highlight ${color.label.toLowerCase()} (${i + 1})`, 'swatch');
        swatch.style.setProperty('--mark', color.fill);
        swatch.setAttribute('aria-label', `Highlight ${color.label.toLowerCase()}`);
        swatch.dataset.color = color.id;
        bar.append(swatch);
      });
      bar.append(el('span', { class: 'tools-sep' }));
      bar.append(
        iconButton(UNDERLINE_SVG, 'Underline (U)', () => this.markSelection('underline')),
        iconButton(STRIKE_SVG, 'Strike through (S)', () => this.markSelection('strike')),
        iconButton(NOTE_SVG, 'Add a note (N)', () => this.markSelection('highlight', undefined, true)),
      );
      // Pressing a button must not clear the selection it acts on.
      bar.addEventListener('pointerdown', (e) => e.preventDefault());
      document.body.append(bar);
      this.selectionBar = bar;
    }
    for (const swatch of this.selectionBar.querySelectorAll<HTMLElement>('.swatch')) {
      swatch.classList.toggle('current', swatch.dataset.color === this.colorId);
    }
    place(this.selectionBar, rect, matchMedia('(pointer: coarse)').matches ? 'below' : 'above');
  }

  private closeSelectionBar(): void {
    this.selectionBar?.remove();
    this.selectionBar = null;
  }

  /** Turn the current selection into a mark (one per page it spans). */
  private markSelection(kind: MarkKind, colorId = this.colorId, withNote = false): void {
    const found = selectedText(this.pages);
    if (found.length === 0) return;
    if (colorId !== this.colorId) {
      this.colorId = colorId;
      writeLastColor(colorId);
    }
    const now = Date.now();
    let last: Mark | null = null;
    for (const { page, boxes, text } of found) {
      const mark: Mark = {
        id: newMarkId(),
        page,
        kind,
        color: toneFor(kind, colorId),
        boxes,
        text,
        note: '',
        created: now,
        updated: now,
      };
      this.history.add(mark);
      last = mark;
    }
    document.getSelection()?.removeAllRanges();
    this.closeSelectionBar();
    this.changed();
    if (withNote && last) this.openPopover(last.id, true);
  }

  // ---- editing a mark ---------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const path = e.composedPath();
    if (this.popover && !path.includes(this.popover.el)) {
      // Clicking another mark re-opens on that one in the click handler.
      this.closePopover();
    }
    if (this.panel && !path.includes(this.panel) && !path.includes(this.notesBtn)) this.closePanel();
  }

  private onClick(e: MouseEvent): void {
    if (e.button !== 0) return;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return;
    const target = e.target as Element | null;
    const holder = target?.closest?.('.pdf-page');
    if (!holder || target?.closest('button, .mark-pop')) return;
    const page = [...this.pages.values()].find((p) => p.holder === holder);
    if (!page) return;
    const r = holder.getBoundingClientRect();
    const [x, y] = page.view.toPdf(e.clientX - r.left, e.clientY - r.top);
    const mark = markAt(this.history.marks, page.pageNumber, x, y);
    if (!mark) return;
    e.preventDefault();
    e.stopPropagation();
    this.openPopover(mark.id);
  }

  private openPopover(id: string, focusNote = false): void {
    this.closePopover();
    const mark = this.history.marks.find((m) => m.id === id);
    const page = mark && this.pages.get(mark.page);
    if (!mark || !page) return;

    const pop = el('div', { class: 'mark-pop', role: 'dialog', 'aria-label': KIND_LABEL[mark.kind] });
    this.popover = { el: pop, id };
    this.renderPopover(pop, mark, focusNote);
    document.body.append(pop);

    const [left, top, width, height] = toCss(page.view, unionBox(mark.boxes));
    const holderRect = page.holder.getBoundingClientRect();
    place(pop, new DOMRect(holderRect.left + left, holderRect.top + top, width, height), 'below');
    this.redraw();
    if (focusNote) pop.querySelector('textarea')?.focus();
    else pop.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  private renderPopover(pop: HTMLElement, mark: Mark, keepFocusOnNote = false): void {
    pop.replaceChildren();
    const row = el('div', { class: 'pop-row' });
    if (mark.kind !== 'note') {
      const current = paletteOf(mark.color)?.id;
      MARK_COLORS.forEach((color, i) => {
        const swatch = button('', () => this.edit(mark.id, { color: toneFor(mark.kind, color.id) }, color.id), `${color.label} (${i + 1})`, 'swatch');
        swatch.style.setProperty('--mark', color.fill);
        swatch.setAttribute('aria-label', color.label);
        swatch.setAttribute('aria-pressed', String(current === color.id));
        row.append(swatch);
      });
      row.append(el('span', { class: 'tools-sep' }));
      for (const kind of ['highlight', 'underline', 'strike'] as const) {
        const b = iconButton(KIND_SVG[kind], `${KIND_LABEL[kind]} (${kind[0]!.toUpperCase()})`, () =>
          this.edit(mark.id, { kind, color: recolorForKind(mark, kind) }),
        );
        b.setAttribute('aria-pressed', String(mark.kind === kind));
        row.append(b);
      }
    }
    const del = iconButton(TRASH_SVG, 'Delete (Del)', () => this.remove(mark.id));
    del.classList.add('danger');
    row.append(el('span', { class: 'grow' }), del);
    pop.append(row);

    if (mark.text) pop.append(el('p', { class: 'pop-quote' }, excerpt(mark.text, 160)));

    const note = document.createElement('textarea');
    note.placeholder = 'Add a note…';
    note.rows = 3;
    note.value = mark.note;
    note.setAttribute('aria-label', 'Note');
    note.addEventListener('input', () => {
      if (this.typingInto !== mark.id) {
        this.history.checkpoint();
        this.typingInto = mark.id;
      }
      this.history.amend(mark.id, { note: note.value });
      this.opts.onChange(this.history.marks);
    });
    note.addEventListener('blur', () => {
      if (this.typingInto === mark.id) {
        this.typingInto = null;
        this.redraw();
      }
    });
    pop.append(note);
    pop.append(el('p', { class: 'pop-hint' }, mark.kind === 'note' ? 'Esc to close' : '1–4 colour · H U S kind · Del delete · Esc close'));
    if (keepFocusOnNote) note.focus();
  }

  private closePopover(): void {
    if (!this.popover) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && this.popover.el.contains(active)) active.blur();
    this.popover.el.remove();
    this.popover = null;
    this.typingInto = null;
    this.redraw();
  }

  private edit(id: string, patch: Partial<Mark>, colorId?: string): void {
    this.typingInto = null;
    this.history.update(id, patch);
    if (colorId) {
      this.colorId = colorId;
      writeLastColor(colorId);
    }
    this.changed();
    const mark = this.history.marks.find((m) => m.id === id);
    if (mark && this.popover?.id === id) this.renderPopover(this.popover.el, mark);
    this.popover?.el.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }

  private remove(id: string): void {
    this.typingInto = null;
    this.history.remove(id);
    this.closePopover();
    this.changed();
    this.flash('Deleted — Ctrl+Z to undo');
  }

  private undo(): void {
    this.typingInto = null;
    if (!this.history.undo()) return;
    this.closePopover();
    this.changed();
  }

  private redo(): void {
    this.typingInto = null;
    if (!this.history.redo()) return;
    this.closePopover();
    this.changed();
  }

  private changed(): void {
    this.opts.onChange(this.history.marks);
    this.redraw();
  }

  // ---- keyboard ---------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing = !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && !e.altKey && key === 's') {
      e.preventDefault();
      void this.save();
      return;
    }
    if (mod && !e.altKey && (key === 'z' || key === 'y') && !typing) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (e.key === 'Escape') {
      if (this.popover) {
        e.preventDefault();
        this.closePopover();
      } else if (this.panel) {
        this.closePanel();
        this.notesBtn.focus();
      } else if (this.selectionBar) {
        document.getSelection()?.removeAllRanges();
        this.closeSelectionBar();
      }
      return;
    }
    if (typing || mod || e.altKey) return;

    const digit = Number.parseInt(e.key, 10);
    const color = digit >= 1 && digit <= MARK_COLORS.length ? MARK_COLORS[digit - 1]! : null;

    if (this.selectionBar && selectedText(this.pages).length > 0) {
      if (color) this.markSelection('highlight', color.id);
      else if (KIND_KEY[key]) this.markSelection(KIND_KEY[key]!);
      else if (key === 'n') this.markSelection('highlight', undefined, true);
      else return;
      e.preventDefault();
      return;
    }

    const open = this.popover && this.history.marks.find((m) => m.id === this.popover!.id);
    if (!open) return;
    if (e.key === 'Delete' || e.key === 'Backspace') this.remove(open.id);
    else if (color && open.kind !== 'note') this.edit(open.id, { color: toneFor(open.kind, color.id) }, color.id);
    else if (KIND_KEY[key] && open.kind !== 'note') this.edit(open.id, { kind: KIND_KEY[key], color: recolorForKind(open, KIND_KEY[key]!) });
    else if (key === 'n') this.popover!.el.querySelector('textarea')?.focus();
    else return;
    e.preventDefault();
  }

  // ---- notes panel ------------------------------------------------------------------

  private togglePanel(): void {
    if (this.panel) {
      this.closePanel();
      return;
    }
    const panel = el('div', { class: 'notes-panel', role: 'dialog', 'aria-label': 'Notes' });
    this.panel = panel;
    this.renderPanel(panel);
    document.body.append(panel);
    this.notesBtn.setAttribute('aria-expanded', 'true');
    panel.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  private renderPanel(panel: HTMLElement): void {
    const marks = inReadingOrder(this.history.marks);
    const head = el('div', { class: 'panel-head' });
    head.append(el('b', {}, marks.length ? `${marks.length} mark${marks.length === 1 ? '' : 's'}` : 'No marks yet'));
    if (marks.length) head.append(button('Copy as text', () => void this.copyNotes(), 'Copy every highlight and note, with page numbers', 'ghost'));
    panel.replaceChildren(head);

    if (marks.length === 0) {
      panel.append(
        el('p', { class: 'panel-empty' }, 'Select text on a page to highlight, underline or strike it through, or to add a note. Everything is kept on this device; Save writes it into the PDF.'),
      );
      return;
    }
    const list = el('ol', { class: 'panel-list' });
    for (const mark of marks) {
      const item = el('li');
      const open = button('', () => this.jumpTo(mark.id), `Go to page ${mark.page}`, 'panel-item');
      const swatch = el('span', { class: `kind ${mark.kind}` });
      swatch.style.setProperty('--mark', mark.color);
      const body = el('span', { class: 'panel-body' });
      body.append(el('span', { class: 'panel-meta' }, `Page ${mark.page} · ${KIND_LABEL[mark.kind]}`));
      if (mark.text) body.append(el('span', { class: 'panel-text' }, excerpt(mark.text, 140)));
      if (mark.note) body.append(el('span', { class: 'panel-note' }, mark.note));
      open.append(swatch, body);
      item.append(open);
      list.append(item);
    }
    panel.append(list);
  }

  private closePanel(): void {
    this.panel?.remove();
    this.panel = null;
    this.notesBtn.setAttribute('aria-expanded', 'false');
  }

  private jumpTo(id: string): void {
    const mark = this.history.marks.find((m) => m.id === id);
    const page = mark && this.pages.get(mark.page);
    if (!mark || !page) return;
    this.closePanel();
    const [, top] = toCss(page.view, unionBox(mark.boxes));
    const y = page.holder.getBoundingClientRect().top + window.scrollY + top - window.innerHeight / 3;
    window.scrollTo({ top: Math.max(0, y), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    // Once the scroll has settled, so the popover is placed against where the mark ends up.
    window.setTimeout(() => this.openPopover(id), 350);
  }

  private async copyNotes(): Promise<void> {
    const lines = [`# ${this.opts.fileName}`, ''];
    for (const mark of inReadingOrder(this.history.marks)) {
      const quote = mark.text ? `> ${mark.text.replace(/\s+/g, ' ')}` : '';
      lines.push(`**Page ${mark.page}** · ${KIND_LABEL[mark.kind]}`);
      if (quote) lines.push(quote);
      if (mark.note) lines.push('', mark.note);
      lines.push('');
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.flash('Copied');
    } catch {
      this.flash('Could not reach the clipboard');
    }
  }

  // ---- saving -----------------------------------------------------------------------

  async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.status.classList.remove('flash');
    this.status.textContent = 'Saving…';
    this.redraw();
    const marks = this.history.marks;
    let result: Awaited<ReturnType<EditorOptions['onSave']>> = null;
    let failure = '';
    try {
      result = await this.opts.onSave(marks);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      this.saving = false;
    }
    if (result) {
      this.savedSignature = signature(marks);
      this.saveMode = result.saveMode;
    }
    this.redraw();
    if (result) this.flash(result.message);
    else if (failure) this.flash(failure, 7000);
  }

  private flashTimer = 0;
  private flash(message: string, ms = 2600): void {
    clearTimeout(this.flashTimer);
    this.status.textContent = message;
    this.status.classList.add('flash');
    this.flashTimer = window.setTimeout(() => {
      this.status.classList.remove('flash');
      this.redraw();
    }, ms);
  }

  // ---- plumbing ---------------------------------------------------------------------

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }
}

// ---- selection -> boxes -----------------------------------------------------------------

/**
 * The selected text, as boxes in PDF space, per page.
 *
 * Each line of the text layer is one text node, so the selection is measured line by line: the
 * part of each line inside the selection, trimmed of the spaces that join lines together, gives
 * one tight rectangle. (A range's own `getClientRects()` also returns the boxes of every element
 * it fully contains, which doubles lines up.)
 */
export function selectedText(pages: Map<number, EditorPage>): Array<{ page: number; boxes: Box[]; text: string }> {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const scope = root.nodeType === Node.TEXT_NODE ? root.parentNode! : root;

  const byPage = new Map<number, { boxes: Box[]; text: string[] }>();
  const holders = new Map<Element, EditorPage>();
  for (const page of pages.values()) holders.set(page.holder, page);

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const part = document.createRange();
  for (let node = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const layer = node.parentElement?.closest('.text-layer');
    const holder = layer?.parentElement;
    const page = holder && holders.get(holder);
    if (!page) continue;

    const text = node.textContent ?? '';
    let start = node === range.startContainer ? range.startOffset : 0;
    let end = node === range.endContainer ? range.endOffset : text.length;
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end <= start) continue;

    part.setStart(node, start);
    part.setEnd(node, end);
    const rect = part.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const h = page.holder.getBoundingClientRect();
    const [x0, y0] = page.view.toPdf(rect.left - h.left, rect.top - h.top);
    const [x1, y1] = page.view.toPdf(rect.right - h.left, rect.bottom - h.top);

    const entry = byPage.get(page.pageNumber) ?? { boxes: [], text: [] };
    entry.boxes.push([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
    entry.text.push(text.slice(start, end));
    byPage.set(page.pageNumber, entry);
  }

  return [...byPage.entries()].map(([page, { boxes, text }]) => ({
    page,
    boxes: mergeLineBoxes(boxes),
    text: text.join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

/** The text-layer lines that sit inside `boxes` — the words a mark from another app covers. */
function textUnder(page: EditorPage, boxes: Box[]): string {
  const h = page.holder.getBoundingClientRect();
  const words: string[] = [];
  for (const span of page.holder.querySelectorAll<HTMLElement>('.text-layer span')) {
    const r = span.getBoundingClientRect();
    const [x, y] = page.view.toPdf((r.left + r.right) / 2 - h.left, (r.top + r.bottom) / 2 - h.top);
    if (boxes.some(([l, b, rt, t]) => x >= l && x <= rt && y >= b && y <= t)) words.push(span.textContent ?? '');
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

/** A PDF-space box as CSS pixels within its page: [left, top, width, height]. */
function toCss(view: PdfPageView, [l, b, r, t]: Box): [number, number, number, number] {
  const [x0, y0] = view.toViewport(l, b);
  const [x1, y1] = view.toViewport(r, t);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

/** Position a floating element next to `anchor` (viewport coordinates), kept on screen. */
function place(float: HTMLElement, anchor: DOMRect, side: 'above' | 'below'): void {
  float.style.visibility = 'hidden';
  float.style.left = '0px';
  float.style.top = '0px';
  const { width, height } = float.getBoundingClientRect();
  const gap = 8;
  let top = side === 'above' ? anchor.top - height - gap : anchor.bottom + gap;
  if (top < 56) top = anchor.bottom + gap;
  if (top + height > window.innerHeight - 8 && side === 'below') top = Math.max(56, anchor.top - height - gap);
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), window.innerWidth - width - 8);
  float.style.left = `${left + window.scrollX}px`;
  float.style.top = `${top + window.scrollY}px`;
  float.style.visibility = '';
}

/** Kind, page, colour, geometry and note — what the file stores — for "is anything unsaved?". */
function signature(marks: readonly Mark[]): string {
  return marks
    .map((m) => [m.page, m.kind, m.color, m.note, m.boxes.map((b) => b.map((v) => v.toFixed(1)).join(',')).join(';')].join('|'))
    .sort()
    .join('\n');
}

function excerpt(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function readLastColor(): string {
  try {
    const id = localStorage.getItem(LAST_COLOR_KEY);
    if (id && MARK_COLORS.some((c) => c.id === id)) return id;
  } catch {
    /* storage unavailable */
  }
  return MARK_COLORS[0]!.id;
}

function writeLastColor(id: string): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

// ---- tiny DOM helpers -------------------------------------------------------------------

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function button(label: string, run: () => void, title = '', cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', ...(cls ? { class: cls } : {}), ...(title ? { title } : {}) }, label) as HTMLButtonElement;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

function iconButton(paths: string[], title: string, run: () => void): HTMLButtonElement {
  const b = button('', run, title, 'icon-btn');
  b.append(svgIcon(document, paths));
  b.setAttribute('aria-label', title.replace(/\s*\(.*\)$/, ''));
  return b;
}

const HIGHLIGHT_SVG = ['M10.6 1.6l3.8 3.8-6.3 6.3-3.8-3.8z', 'M3.7 8.7l3.6 3.6-1.4 1.4H2.3v-3.6z', 'M1 14.5h14V16H1z'];
const UNDERLINE_SVG = ['M4 1.5h1.8v5.8a2.2 2.2 0 004.4 0V1.5H12v5.8a4 4 0 01-8 0z', 'M3 13.2h10V15H3z'];
const STRIKE_SVG = [
  'M8 1.5c1.9 0 3.3.9 3.8 2.4l-1.7.6C9.8 3.7 9 3.2 8 3.2c-1.2 0-2 .6-2 1.4 0 .6.4 1 1.3 1.3H4.6a2.9 2.9 0 01-.4-1.4c0-1.8 1.6-3 3.8-3z',
  'M1.5 7.2h13V9h-3a3 3 0 01.8 2c0 2-1.8 3.4-4.3 3.4-2.1 0-3.7-1-4.2-2.7l1.7-.6c.3 1 1.2 1.6 2.5 1.6 1.4 0 2.5-.7 2.5-1.7 0-.8-.6-1.4-2.3-2H1.5z',
];
const NOTE_SVG = ['M2 2h12a1 1 0 011 1v8a1 1 0 01-1 1H7l-3.5 3v-3H2a1 1 0 01-1-1V3a1 1 0 011-1zm2 3v1.5h8V5zm0 3v1.5h5.5V8z'];
const TRASH_SVG = ['M6 1h4l.6 1H14v1.6H2V2h3.4zM3.2 4.6h9.6l-.7 9.6a1 1 0 01-1 .8H4.9a1 1 0 01-1-.8zm3 1.6v7h1.5v-7zm2.6 0v7h1.5v-7z'];
const UNDO_SVG = ['M5.5 3L1 6.8l4.5 3.8V7.8H10a3.2 3.2 0 010 6.4H6V16h4a5 5 0 000-10H5.5z'];
const REDO_SVG = ['M10.5 3L15 6.8l-4.5 3.8V7.8H6a3.2 3.2 0 000 6.4h4V16H6A5 5 0 016 6h4.5z'];
const KIND_SVG: Record<'highlight' | 'underline' | 'strike', string[]> = {
  highlight: HIGHLIGHT_SVG,
  underline: UNDERLINE_SVG,
  strike: STRIKE_SVG,
};
