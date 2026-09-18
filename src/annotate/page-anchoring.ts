/**
 * Anchors (annotate/anchor.ts) meet the live DOM: a selection becomes an anchor, and an anchor
 * becomes a Range on the page again.
 *
 * Both go through the same flattened page text the reader uses (`extract/text-index.ts`), which
 * leaves out scripts, hidden elements and the like — so what is quoted is what a person sees.
 */
import { buildTextIndex, rangeForSpan, type TextIndex } from '@/extract/text-index';
import { createAnchor, findAnchor, type TextAnchor } from './anchor';

export function pageIndex(doc: Document = document): TextIndex | null {
  return doc.body ? buildTextIndex(doc.body) : null;
}

/** The anchor and plain text for a selected range, or null when it holds no page text. */
export function anchorForRange(index: TextIndex, range: Range): { anchor: TextAnchor; text: string } | null {
  let start = -1;
  let end = -1;
  for (const piece of index.pieces) {
    if (!range.intersectsNode(piece.node)) continue;
    const from = piece.node === range.startContainer ? range.startOffset : 0;
    const to = piece.node === range.endContainer ? range.endOffset : piece.len;
    if (to <= from) continue;
    if (start < 0) start = piece.at + from;
    end = piece.at + to;
  }
  if (start < 0 || end <= start) return null;
  const anchor = createAnchor(index.fullText, start, end);
  if (!anchor) return null;
  return { anchor, text: anchor.exact };
}

/** The Range for an anchor on this page now, or null when its text is no longer there. */
export function rangeForAnchor(index: TextIndex, anchor: TextAnchor): Range | null {
  const found = findAnchor(index.fullText, anchor);
  return found ? rangeForSpan(index, found.start, found.end) : null;
}
