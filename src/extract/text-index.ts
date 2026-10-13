/**
 * A flat, offset-addressable view of the *live* DOM's visible prose.
 *
 * `fullText` is the concatenation of every visible text node under `root`, verbatim, with a
 * single "\n" inserted at block-element boundaries. Because node text is copied verbatim, a
 * character offset into `fullText` maps directly back to a `(Text, offset)` pair, and therefore
 * to a `Range` — this is what lets us highlight a sentence in place without touching the DOM.
 */

import { Eligibility } from './eligibility';

export const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
  'ARTICLE', 'SECTION', 'FIGCAPTION', 'DD', 'DT', 'TD', 'TH', 'TR', 'CAPTION',
  'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'DETAILS', 'SUMMARY', 'FORM',
]);

// Genuinely non-prose subtrees. `CODE`/`KBD`/`SAMP` are deliberately NOT here: inline
// `<code>` is part of a sentence and Readability keeps it in the spoken text, so dropping
// it from the highlight index desyncs alignment for every sentence that contains one.
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO',
  'SELECT', 'TEXTAREA', 'OPTION', 'BUTTON', 'INPUT',
]);

export interface Piece {
  node: Text;
  /**
   * In a reader index: whether this text is read *now* — rendered and not part of a control.
   * Kept per piece because it changes while reading (a translation revealed, a section hidden)
   * and is checked again when the page changes (see `refreshEligibility`).
   */
  eligible?: boolean;
  /** Offset into fullText where this node's text begins. */
  at: number;
  /** node.data.length at build time. */
  len: number;
}

export interface TextIndex {
  root: Element;
  fullText: string;
  pieces: Piece[];
  /** Built for the reader (see `buildTextIndex`'s `forReader`). */
  forReader?: boolean;
}

export function isHidden(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: (opts?: unknown) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    return !anyEl.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
  }
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return false;
  return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}

export function nearestBlock(node: Node, root: Element): Element {
  let el: Element | null = node.parentElement;
  while (el && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return root;
}

/**
 * Index the text under `root`.
 *
 * By default, the visible text — what page annotations anchor to, unchanged so saved highlights
 * keep their places. With `forReader`, the reader's view: controls are left out entirely ("Translate?"
 * is never prose), and text that is not rendered *now* is kept but marked ineligible, so revealing
 * a translation while reading makes it readable in place, without rebuilding the plan.
 */
export function buildTextIndex(root: Element, opts: { forReader?: boolean } = {}): TextIndex {
  const doc = root.ownerDocument;
  const pieces: Piece[] = [];
  let full = '';
  let prevBlock: Element | null = null;
  const reader = opts.forReader ? new Eligibility() : null;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        // The reader keeps `aria-hidden` and `hidden` text as hidden candidates rather than leaving
        // it out: a disclosure that reveals a translation removes both, and text never indexed
        // could not be read once it appeared (Eligibility treats both as hidden meanwhile).
        if (!reader && el.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        if (!reader && el.hasAttribute('hidden')) return NodeFilter.FILTER_REJECT;
      }
      if (reader) {
        return node.parentElement && reader.inControl(node.parentElement, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
      // Visibility check only on the direct parent — cheap and catches the common cases.
      if (node.parentElement && isHidden(node.parentElement)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node = walker.nextNode() as Text | null;
  while (node) {
    const block = nearestBlock(node, root);
    if (prevBlock && block !== prevBlock && full.length > 0 && !full.endsWith('\n')) {
      full += '\n';
    }
    prevBlock = block;

    const data = node.data;
    pieces.push({ node, at: full.length, len: data.length, ...(reader ? { eligible: reader.rendered(node) } : {}) });
    full += data;

    node = walker.nextNode() as Text | null;
  }

  return { root, fullText: full, pieces, ...(reader ? { forReader: true } : {}) };
}

/**
 * Re-read which pieces are rendered now; true when any changed. A translation revealed or a
 * section collapsed while reading.
 */
export function refreshEligibility(index: TextIndex): boolean {
  return changedEligibility(index).length > 0;
}

/**
 * Re-read which pieces are rendered now, and return where it changed: `[start, end)` ranges of
 * `fullText`, merged. Only the sentences over these need to be looked at again.
 */
export function changedEligibility(index: TextIndex): Array<[number, number]> {
  if (!index.forReader) return [];
  const check = new Eligibility();
  const ranges: Array<[number, number]> = [];
  for (const piece of index.pieces) {
    const now = piece.node.isConnected && check.rendered(piece.node);
    if (now === piece.eligible) continue;
    piece.eligible = now;
    const last = ranges[ranges.length - 1];
    if (last && piece.at <= last[1] + 1) last[1] = piece.at + piece.len;
    else ranges.push([piece.at, piece.at + piece.len]);
  }
  return ranges;
}

/**
 * Is the text in `[start, end)` read? In a reader index, true when most of its characters are
 * in eligible pieces — a sentence is spoken or not as a whole. Always true in a plain index.
 */
export function spanEligible(index: TextIndex, start: number, end: number): boolean {
  if (!index.forReader || end <= start) return true;
  let yes = 0;
  let no = 0;
  for (let i = pieceIndexAt(index.pieces, start); i < index.pieces.length; i++) {
    const p = index.pieces[i]!;
    if (p.at >= end) break;
    const overlap = Math.min(end, p.at + p.len) - Math.max(start, p.at);
    if (overlap <= 0) continue;
    if (p.eligible === false) no += overlap;
    else yes += overlap;
  }
  return yes > no;
}

/**
 * The text of `[start, end)` as it is read: in a reader index, what is hidden on the page now is
 * blanked out (a hidden word inside a visible sentence is not said), then spaces are tidied. The
 * text itself, unchanged, in a plain index.
 */
export function visibleTextOf(index: TextIndex, start: number, end: number): string {
  const text = index.fullText.slice(start, end);
  if (!index.forReader || end <= start) return text;
  let out = text;
  let blanked = false;
  for (let i = pieceIndexAt(index.pieces, start); i < index.pieces.length; i++) {
    const p = index.pieces[i]!;
    if (p.at >= end) break;
    if (p.eligible !== false) continue;
    const from = Math.max(start, p.at) - start;
    const to = Math.min(end, p.at + p.len) - start;
    if (to <= from) continue;
    out = out.slice(0, from) + ' '.repeat(to - from) + out.slice(to);
    blanked = true;
  }
  return blanked ? out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?…])/g, '$1').trim() : text;
}

/** Binary search for the piece containing `offset` (or the first piece starting at/after it). */
function pieceIndexAt(pieces: Piece[], offset: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  let ans = pieces.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pieces[mid]!;
    if (p.at + p.len <= offset) {
      lo = mid + 1;
    } else {
      ans = mid;
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Build a DOM Range for `[start, end)` of `fullText`. Offsets that land in a synthetic "\n"
 * gap are snapped inward to the nearest real text.
 */
export function rangeForSpan(index: TextIndex, start: number, end: number): Range | null {
  const { pieces, root } = index;
  if (pieces.length === 0 || end <= start) return null;

  const si = pieceIndexAt(pieces, start);
  const ei = pieceIndexAt(pieces, Math.max(start, end - 1));
  if (si >= pieces.length) return null;

  const startPiece = pieces[si]!;
  const endPiece = pieces[Math.min(ei, pieces.length - 1)]!;

  const range = root.ownerDocument.createRange();
  const startOffset = Math.max(0, Math.min(start - startPiece.at, startPiece.len));
  const endOffset = Math.max(0, Math.min(end - endPiece.at, endPiece.len));

  try {
    range.setStart(startPiece.node, startOffset);
    range.setEnd(endPiece.node, endOffset);
    if (range.collapsed && startPiece === endPiece) {
      range.setEnd(endPiece.node, Math.min(startOffset + 1, endPiece.len));
    }
    return range;
  } catch {
    return null;
  }
}
