/**
 * A flat, offset-addressable view of the *live* DOM's visible prose.
 *
 * `fullText` is the concatenation of every visible text node under `root`, verbatim, with a
 * single "\n" inserted at block-element boundaries. Because node text is copied verbatim, a
 * character offset into `fullText` maps directly back to a `(Text, offset)` pair, and therefore
 * to a `Range` — this is what lets us highlight a sentence in place without touching the DOM.
 */

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
  /** Offset into fullText where this node's text begins. */
  at: number;
  /** node.data.length at build time. */
  len: number;
}

export interface TextIndex {
  root: Element;
  fullText: string;
  pieces: Piece[];
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

export function buildTextIndex(root: Element): TextIndex {
  const doc = root.ownerDocument;
  const pieces: Piece[] = [];
  let full = '';
  let prevBlock: Element | null = null;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        if (el.hasAttribute('hidden')) return NodeFilter.FILTER_REJECT;
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
    pieces.push({ node, at: full.length, len: data.length });
    full += data;

    node = walker.nextNode() as Text | null;
  }

  return { root, fullText: full, pieces };
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
