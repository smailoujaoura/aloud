/**
 * "Where in the playlist is *that*?" — the geometric queries that map a place on the page to a
 * sentence index.
 *
 * These back "Read from here", the click-to-jump feature, and the viewport fallback used when
 * the browser cannot tell us which element was right-clicked (everywhere except Firefox, which
 * has `menus.getTargetElement`). They read layout but change nothing, so they live apart from
 * the session that acts on their answers.
 */
import type { PlaylistItem } from './playlist';

/** Pixels of slop at the top of the viewport before a sentence counts as "scrolled past". */
const ABOVE_FOLD_SLOP_PX = 8;

/**
 * The first sentence currently on screen — what "here" means for "Read from here" when no
 * click target is available. Falls back to the last sentence scrolled past, so a reader who has
 * scrolled beyond the end of the article resumes near where they were rather than at the top.
 */
export function firstSentenceInViewport(playlist: PlaylistItem[], win: Window = window): number {
  const viewportHeight = win.innerHeight || win.document.documentElement.clientHeight;
  let lastAbove = 0;

  for (const item of playlist) {
    const rect = item.range?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) continue; // not rendered
    if (rect.bottom > ABOVE_FOLD_SLOP_PX && rect.top < viewportHeight) return item.playId;
    if (rect.bottom <= ABOVE_FOLD_SLOP_PX) lastAbove = item.playId;
  }

  return lastAbove;
}

/**
 * The first sentence at or inside `el` in document order — where "Read from here" starts when
 * the browser did tell us which element was right-clicked. Falls back to the last sentence
 * before `el`, so clicking a figure or an ad between paragraphs resumes at the nearest text.
 */
export function indexNearElement(playlist: PlaylistItem[], el: Element): number {
  let lastBefore = 0;

  for (const item of playlist) {
    const node = item.range?.startContainer;
    if (!node) continue;
    const relation = el.compareDocumentPosition(node);
    const atOrInside =
      relation === 0 ||
      (relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ||
      (relation & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0;
    if (atOrInside) return item.playId;
    lastBefore = item.playId;
  }

  return lastBefore;
}

/**
 * The sentence under a viewport point, for click-to-jump. Returns null when the point resolves
 * to no text node at all (e.g. a click on the page background).
 */
export function indexAtPoint(
  playlist: PlaylistItem[],
  x: number,
  y: number,
  doc: Document = document,
): number | null {
  const caret = caretAt(doc, x, y);
  if (!caret) return null;
  // On the text itself, not merely near it: the caret APIs return the nearest position to *any*
  // point, so a click on blank space — a margin, the gap between paragraphs — used to land in
  // some sentence and move the reading, often far from where the reader was.
  if (!onGlyph(doc, caret, x, y)) return null;

  for (const item of playlist) {
    try {
      if (item.range?.isPointInRange(caret.node, caret.offset)) return item.playId;
    } catch {
      /* the caret node is in a different tree than this range — not a match */
    }
  }

  // Between two sentences (a margin, a caption, a list bullet): snap by document order.
  const el = caret.node.nodeType === Node.ELEMENT_NODE ? (caret.node as Element) : caret.node.parentElement;
  return el ? indexNearElement(playlist, el) : null;
}

/** Is (x, y) on the character at the caret, or the one before it? A few pixels of slack. */
function onGlyph(doc: Document, caret: { node: Node; offset: number }, x: number, y: number): boolean {
  if (caret.node.nodeType !== Node.TEXT_NODE) return false;
  const length = (caret.node as Text).length;
  const range = doc.createRange();
  const SLACK = 3;
  for (const start of [caret.offset - 1, caret.offset]) {
    if (start < 0 || start >= length) continue;
    range.setStart(caret.node, start);
    range.setEnd(caret.node, start + 1);
    for (const r of range.getClientRects()) {
      if (x >= r.left - SLACK && x <= r.right + SLACK && y >= r.top - SLACK && y <= r.bottom + SLACK) return true;
    }
  }
  return false;
}

/**
 * `caretPositionFromPoint` is the standard; `caretRangeFromPoint` is the older WebKit/Blink name
 * still needed for Chromium before 128. Try both.
 */
function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  const position = d.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };

  const range = d.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };

  return null;
}
