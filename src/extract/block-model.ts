/**
 * Structure-aware reading model.
 *
 * Instead of segmenting Readability's serialised text and then fuzzy-locating each sentence
 * in the live DOM (which desyncs the moment the two texts disagree, so a sentence gets
 * spoken but not highlighted), we walk the *live* DOM's own block structure in document
 * order and read that. Every block maps to an exact `[start, end)` slice of the
 * `TextIndex.fullText`, so a sentence's highlight range is produced by pure offset
 * arithmetic — spoken order ≡ highlight order ≡ document order, by construction.
 *
 * Readability is still used, but only to (a) get the title/lang and (b) supply a
 * "this is real content" text blob we use to drop boilerplate blocks (related-links,
 * newsletter prompts, comment counts) that live inside the resolved root.
 */
import { canonicalize } from '@/align/fuzzy-align';
import type { ExtractedArticle } from './readability';
import { nearestBlock, isHidden, type TextIndex } from './text-index';

export type BlockRole =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'listitem'
  | 'quote'
  | 'caption'
  | 'code'
  | 'other';

export interface Block {
  /** Index into `TextIndex.fullText` where this block's text starts. */
  start: number;
  /** Exclusive end offset into `TextIndex.fullText`. */
  end: number;
  role: BlockRole;
  /** Heading level 1–6, else 0. */
  level: number;
  /** The nearest block element in the live DOM (null for the synthetic title block). */
  el: Element | null;
}

export interface BlockModelOptions {
  /** Drop blocks whose text is absent from this (Readability) reference text. */
  referenceText?: string;
  /** Prepend the article title as its own block. */
  title?: string;
}

const HEADING_TAGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
const BOILERPLATE_ANCESTOR =
  'nav, aside, footer, header, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], .comments, #comments, .related, .newsletter, .share, .social';

function roleFor(el: Element): { role: BlockRole; level: number } {
  const tag = el.tagName;
  if (tag in HEADING_TAGS) return { role: 'heading', level: HEADING_TAGS[tag]! };
  if (el.getAttribute('role') === 'heading') {
    const lvl = Number(el.getAttribute('aria-level')) || 2;
    return { role: 'heading', level: Math.min(6, Math.max(1, lvl)) };
  }
  if (tag === 'LI' || el.closest('li')) return { role: 'listitem', level: 0 };
  if (tag === 'BLOCKQUOTE' || el.closest('blockquote')) return { role: 'quote', level: 0 };
  if (tag === 'FIGCAPTION' || tag === 'CAPTION') return { role: 'caption', level: 0 };
  if (tag === 'PRE' || el.closest('pre')) return { role: 'code', level: 0 };
  if (tag === 'DT' || tag === 'DD' || tag === 'TD' || tag === 'TH') return { role: 'other', level: 0 };
  return { role: 'paragraph', level: 0 };
}

function linkTextRatio(el: Element): number {
  const total = (el.textContent ?? '').length || 1;
  let linkLen = 0;
  el.querySelectorAll('a').forEach((a) => (linkLen += (a.textContent ?? '').length));
  return linkLen / total;
}

/**
 * Partition `index.fullText` into ordered blocks. Adjacent pieces that share a nearest
 * block element become one block — mirrors how `buildTextIndex` inserts a "\n" whenever the
 * nearest block changes, so block spans line up with those newline boundaries.
 */
export function buildBlockModel(index: TextIndex, opts: BlockModelOptions = {}): Block[] {
  const { root, pieces } = index;
  const groups: Array<{ el: Element; start: number; end: number }> = [];
  for (const p of pieces) {
    const el = nearestBlock(p.node, root);
    const last = groups[groups.length - 1];
    if (last && last.el === el) {
      last.end = p.at + p.len;
    } else {
      groups.push({ el, start: p.at, end: p.at + p.len });
    }
  }

  const ref = opts.referenceText ? canonicalize(opts.referenceText).text : '';
  const useRef = ref.length > 200;

  const blocks: Block[] = [];

  if (opts.title && opts.title.trim()) {
    const t = opts.title.trim();
    // Locate the title in the index if a heading element carries it (so it highlights);
    // otherwise emit it as a spoken-only block (start === end, no range).
    const canonTitle = canonicalize(t).text;
    const g = groups.find((grp) => {
      const c = canonicalize(index.fullText.slice(grp.start, grp.end)).text;
      return c === canonTitle || (canonTitle.length > 8 && c.includes(canonTitle));
    });
    if (g) {
      blocks.push({ start: g.start, end: g.end, role: 'title', level: 0, el: g.el });
      g.start = g.end; // consumed — don't emit it again below
    } else {
      blocks.push({ start: 0, end: 0, role: 'title', level: 0, el: null });
    }
  }

  for (const g of groups) {
    if (g.end <= g.start) continue;
    const text = index.fullText.slice(g.start, g.end);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;

    const { role, level } = roleFor(g.el);

    if (g.el.closest(BOILERPLATE_ANCESTOR) && role !== 'heading') continue;
    if (isHidden(g.el)) continue;
    if (role !== 'heading' && text.length > 40 && linkTextRatio(g.el) > 0.7) continue;

    if (useRef) {
      const c = canonicalize(text).text;
      // Headings are short and may be reworded in Readability output — keep them.
      // Longer blocks must be recognisably present in the reference content.
      if (role !== 'heading' && c.length >= 24) {
        const probe = c.length > 120 ? c.slice(0, 120) : c;
        if (!ref.includes(probe)) continue;
      }
    }

    blocks.push({ start: g.start, end: g.end, role, level, el: g.el });
  }

  return blocks;
}
