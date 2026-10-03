/**
 * Marks on a PDF: highlights, underlines, strike-throughs and notes.
 *
 * Everything is stored in **PDF user space** — points from the bottom-left of the page, the same
 * coordinates the file itself uses — never in screen pixels. That is what lets one set of marks
 * survive a window resize, draw on a phone and a monitor alike, and be written into the file as
 * real PDF annotations that Acrobat, Preview, Firefox and Chrome all show.
 *
 * Pure data and pure functions only; drawing, storage and writing the file live next door.
 */

export type MarkKind = 'highlight' | 'underline' | 'strike' | 'note';

/** An axis-aligned box in PDF user space: [left, bottom, right, top], left < right, bottom < top. */
export type Box = [number, number, number, number];

export interface Mark {
  id: string;
  /** 1-based page number. */
  page: number;
  kind: MarkKind;
  /** `#rrggbb`, exactly as drawn: the highlighter tone for highlights, the ink tone for lines. */
  color: string;
  /** One box per line of marked text. A `note` has a single box: its icon. */
  boxes: Box[];
  /** The text that was marked, for the notes list. Empty for a free-standing note. */
  text: string;
  /** The comment attached to it, if any. */
  note: string;
  created: number;
  updated: number;
  /** Set when the mark came from the file rather than from Aloud (see `MarkOrigin`). */
  origin?: MarkOrigin;
}

/**
 * Where an imported mark came from, so saving does not rewrite someone else's annotation.
 *
 * Saving used to delete every annotation it could read and write each back as new: an untouched
 * sticky note from "Original reviewer", made in 2020, came back authored by "Aloud" and dated
 * today. Now an imported mark that is unchanged keeps its original annotation exactly; one that
 * was edited is rewritten with its original author, creation date and flags.
 */
export interface MarkOrigin {
  /** The annotation's PDF object, as pdf.js names it (`12R`, or `12R3` for generation 3); null when inline. */
  ref: string | null;
  /** Its author (`/T`), empty when it had none. */
  author: string;
  /** Its `/CreationDate`, exactly as written in the file. */
  created: string | null;
  /** Its annotation flags (`/F`). */
  flags: number | null;
  /** `markFingerprint` as imported: a different one now means the mark was edited. */
  fingerprint: string;
}

/** What a mark looks like on the page, for telling an edited imported mark from an untouched one. */
export function markFingerprint(mark: Pick<Mark, 'kind' | 'color' | 'boxes' | 'note'>): string {
  const r = (v: number): number => Math.round(v * 100) / 100;
  return JSON.stringify([mark.kind, mark.color.toLowerCase(), mark.boxes.map((b) => b.map(r)), mark.note]);
}

export interface MarkColor {
  id: string;
  label: string;
  /** Drawn under text with multiply blending, like a highlighter pen. */
  fill: string;
  /** A darker tone for underlines and strike-throughs, which a pale colour would lose. */
  ink: string;
}

export const MARK_COLORS: readonly MarkColor[] = [
  { id: 'yellow', label: 'Yellow', fill: '#ffd83a', ink: '#c28f00' },
  { id: 'green', label: 'Green', fill: '#7fe08a', ink: '#1e8e3e' },
  { id: 'blue', label: 'Blue', fill: '#8cc8ff', ink: '#1a6fe0' },
  { id: 'pink', label: 'Pink', fill: '#ff9fd0', ink: '#cc1f7a' },
];

/** The tone of palette colour `colorId` a mark of `kind` is drawn in. */
export function toneFor(kind: MarkKind, colorId: string): string {
  const color = MARK_COLORS.find((c) => c.id === colorId) ?? MARK_COLORS[0]!;
  return kind === 'underline' || kind === 'strike' ? color.ink : color.fill;
}

/** Which palette colour a mark's colour is, if it is one; null for colours from other software. */
export function paletteOf(color: string): MarkColor | null {
  const hex = color.toLowerCase();
  return MARK_COLORS.find((c) => c.fill === hex || c.ink === hex) ?? null;
}

/**
 * The colour a mark should have after its kind changes: a palette colour switches tone (a
 * highlight turned underline goes from pale yellow to dark yellow), anything else is kept.
 */
export function recolorForKind(mark: Mark, kind: MarkKind): string {
  const palette = paletteOf(mark.color);
  return palette ? toneFor(kind, palette.id) : mark.color;
}

export function newMarkId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- geometry ----------------------------------------------------------------

/**
 * Merge rectangles on the same line into one box per line.
 *
 * A selection comes back as one rectangle per text run, and runs on one line overlap or leave
 * hairline gaps between words; drawn separately they give a highlight with seams and doubled
 * (darker) overlaps. Two rectangles are one line when they share most of their height and sit
 * close enough horizontally.
 */
export function mergeLineBoxes(boxes: Box[]): Box[] {
  const sorted = boxes
    .filter(([l, b, r, t]) => r - l > 0.01 && t - b > 0.01)
    .map((b) => [...b] as Box)
    .sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out: Box[] = [];
  for (const box of sorted) {
    const line = out.find((o) => sameLine(o, box));
    if (line) {
      line[0] = Math.min(line[0], box[0]);
      line[1] = Math.min(line[1], box[1]);
      line[2] = Math.max(line[2], box[2]);
      line[3] = Math.max(line[3], box[3]);
    } else {
      out.push(box);
    }
  }
  return out.sort((a, b) => b[3] - a[3] || a[0] - b[0]);
}

function sameLine(a: Box, b: Box): boolean {
  const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const height = Math.min(a[3] - a[1], b[3] - b[1]);
  if (overlap < height * 0.6) return false;
  const gap = Math.max(a[0], b[0]) - Math.min(a[2], b[2]);
  return gap < Math.max(a[3] - a[1], b[3] - b[1]) * 1.5;
}

/** The smallest box around all of `boxes`. */
export function unionBox(boxes: Box[]): Box {
  return boxes.reduce<Box>(
    (u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

/** The mark under a point on `page`, preferring the most recently made when marks overlap. */
export function markAt(marks: readonly Mark[], page: number, x: number, y: number, slop = 1.5): Mark | null {
  let hit: Mark | null = null;
  for (const mark of marks) {
    if (mark.page !== page) continue;
    const inside = mark.boxes.some(
      ([l, b, r, t]) => x >= l - slop && x <= r + slop && y >= b - slop && y <= t + slop,
    );
    if (inside && (!hit || mark.created >= hit.created)) hit = mark;
  }
  return hit;
}

/** Reading order for the notes list: by page, then top to bottom, then left to right. */
export function inReadingOrder(marks: readonly Mark[]): Mark[] {
  return [...marks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const ta = unionBox(a.boxes);
    const tb = unionBox(b.boxes);
    return tb[3] - ta[3] || ta[0] - tb[0];
  });
}

// ---- marks already in the file ------------------------------------------------

/** pdf.js annotation types this editor owns. Anything else stays part of the page drawing. */
export const PDFJS_TYPES: Record<number, MarkKind> = { 1: 'note', 9: 'highlight', 10: 'underline', 12: 'strike' };

/** The PDF subtypes that correspond, for stripping and writing. */
export const PDF_SUBTYPES: Record<MarkKind, string> = {
  note: 'Text',
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'StrikeOut',
};

/** The parts of a pdf.js annotation this needs. */
export interface PdfJsAnnotation {
  annotationType: number;
  rect?: number[];
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  contentsObj?: { str?: string } | null;
  noView?: boolean;
  /** The PDF object reference, `12R`; `annot_…` for an annotation written inline. */
  id?: string;
  titleObj?: { str?: string } | null;
  creationDate?: string | null;
  annotationFlags?: number;
}

/**
 * Turn a page's existing highlights, underlines, strike-throughs and sticky notes — made in
 * Acrobat, Preview, or by Aloud on another device — into editable marks.
 */
export function importAnnotations(page: number, annotations: readonly PdfJsAnnotation[], now = Date.now()): Mark[] {
  const marks: Mark[] = [];
  for (const a of annotations) {
    const kind = PDFJS_TYPES[a.annotationType];
    if (!kind || a.noView) continue;
    const boxes = kind === 'note' ? rectBox(a.rect) : quadBoxes(a.quadPoints) ?? rectBox(a.rect);
    if (boxes.length === 0) continue;
    const mark: Mark = {
      id: newMarkId(),
      page,
      kind,
      color: hexOf(a.color) ?? (kind === 'note' ? MARK_COLORS[0]!.fill : toneFor(kind, 'yellow')),
      boxes,
      text: '',
      note: a.contentsObj?.str?.trim() ?? '',
      created: now,
      updated: now,
    };
    mark.origin = {
      ref: a.id && /^\d+R\d*$/.test(a.id) ? a.id : null,
      author: a.titleObj?.str ?? '',
      created: typeof a.creationDate === 'string' ? a.creationDate : null,
      flags: typeof a.annotationFlags === 'number' ? a.annotationFlags : null,
      fingerprint: markFingerprint(mark),
    };
    marks.push(mark);
  }
  return marks;
}

function quadBoxes(q: ArrayLike<number> | null | undefined): Box[] | null {
  if (!q || q.length < 8) return null;
  const boxes: Box[] = [];
  for (let i = 0; i + 8 <= q.length; i += 8) {
    const xs = [q[i]!, q[i + 2]!, q[i + 4]!, q[i + 6]!];
    const ys = [q[i + 1]!, q[i + 3]!, q[i + 5]!, q[i + 7]!];
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return boxes;
}

function rectBox(rect: number[] | undefined): Box[] {
  if (!rect || rect.length < 4) return [];
  const [x0, y0, x1, y1] = rect as [number, number, number, number];
  return [[Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]];
}

function hexOf(color: ArrayLike<number> | null | undefined): string | null {
  if (!color || color.length !== 3) return null;
  return `#${Array.from(color, (c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** `#rrggbb` -> [r, g, b] in 0..1, as PDF colour operands. */
export function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---- undo ----------------------------------------------------------------------

/** The marks, with undo and redo. Every change replaces the array, so snapshots are cheap. */
export class MarkHistory {
  private past: Mark[][] = [];
  private future: Mark[][] = [];

  constructor(
    private current: Mark[] = [],
    private readonly limit = 100,
  ) {}

  get marks(): readonly Mark[] {
    return this.current;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  add(mark: Mark): void {
    this.commit([...this.current, mark]);
  }

  update(id: string, patch: Partial<Omit<Mark, 'id' | 'created'>>, now = Date.now()): void {
    const index = this.current.findIndex((m) => m.id === id);
    if (index < 0) return;
    const next = [...this.current];
    next[index] = { ...next[index]!, ...patch, updated: now };
    this.commit(next);
  }

  /**
   * Change a mark without an undo step of its own — for typing a note, which would otherwise
   * be one undo per keystroke. The step is taken once, when typing into that note begins.
   */
  amend(id: string, patch: Partial<Omit<Mark, 'id' | 'created'>>, now = Date.now()): void {
    const index = this.current.findIndex((m) => m.id === id);
    if (index < 0) return;
    const next = [...this.current];
    next[index] = { ...next[index]!, ...patch, updated: now };
    this.current = next;
  }

  /** Record the present as an undo step without changing it (see `amend`). */
  checkpoint(): void {
    this.past.push(this.current);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  remove(id: string): void {
    if (!this.current.some((m) => m.id === id)) return;
    this.commit(this.current.filter((m) => m.id !== id));
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.current);
    this.current = previous;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.current);
    this.current = next;
    return true;
  }

  private commit(next: Mark[]): void {
    this.checkpoint();
    this.current = next;
  }
}
