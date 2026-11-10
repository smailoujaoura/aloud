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
 *
 * Readability is not the last word, though. It removes every `<aside>` (a documentation page's
 * notes and warnings: article-asides.ts) and anything whose class sounds like a header, a comment
 * or a menu, so a passage between two paragraphs it kept could be missing from what it returned
 * for no reason a reader would agree with. Such a passage is read when nothing around it says it is
 * promotion, navigation or a form (`restoreBetween`).
 */
import { canonicalize } from '@/align/fuzzy-align';
import type { ExtractedArticle } from './readability';
import { nearestBlock, isHidden, type TextIndex } from './text-index';
import { asideAround, namesOf, NOT_CONTENT } from './article-asides';

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

  const asides = new Map<Element, Element | null>();
  /** Every block that passed, with `missing` set where only Readability left it out. */
  const kept: Kept[] = [];
  for (const g of groups) {
    if (g.end <= g.start) continue;
    const text = index.fullText.slice(g.start, g.end);
    if (!/[\p{L}\p{N}]/u.test(text)) continue;

    const { role, level } = roleFor(g.el);

    if (role !== 'heading' && boilerplate(g.el, root, asides)) continue;
    // The reader keeps blocks hidden *now* as candidates — a translation revealed while reading is
    // read in place — and marks each sentence eligible or not (content/playlist.ts).
    if (!index.forReader && isHidden(g.el)) continue;
    if (role !== 'heading' && text.length > 40 && linkTextRatio(g.el) > 0.7) continue;

    let missing = false;
    let confirmed = false;
    // A note in the article (article-asides.ts) is read whatever Readability made of it.
    if (useRef && !asideAround(g.el, root, asides)) {
      const c = canonicalize(text).text;
      // Headings are short and may be reworded in Readability output — keep them.
      // Longer blocks must be recognisably present in the reference content.
      if (role !== 'heading' && c.length >= 24) {
        const probe = c.length > 120 ? c.slice(0, 120) : c;
        missing = !ref.includes(probe);
        confirmed = !missing;
      }
    }

    kept.push({ block: { start: g.start, end: g.end, role, level, el: g.el }, missing, confirmed });
  }

  if (useRef) restoreBetween(kept, blocks.length ? blocks[0]! : null);
  for (const k of kept) if (!k.missing) blocks.push(k.block);
  return blocks;
}

/**
 * Bring back a passage Readability left out when the article goes on around it: a paragraph it
 * kept before it and one after, and nothing between it and them naming it promotion, navigation
 * or discussion (article-asides.ts: NOT_CONTENT), nor holding a form. At the ends of the article
 * Readability is left to decide: that is where bylines, share bars and related links are.
 */
function restoreBetween(kept: Kept[], title: Block | null): void {
  // Only text Readability returned says the article is there: a short line ("Hidden categories:",
  // "Share") is kept without being checked, and counted as article it let a page's footer back in.
  // Or the article's title: what comes between it and the first paragraph Readability kept is
  // where an article opens (MDN's first section was all left out).
  const before: Array<Element | null> = [];
  const titleAt = title?.el && title.end > title.start ? title : null;
  let last: Element | null = null;
  for (const k of kept) {
    // The title counts from where it is: a line above it (a kicker, a dateline) is not between it
    // and the article.
    if (!last && titleAt && k.block.start >= titleAt.end) last = titleAt.el;
    before.push(last);
    if (k.confirmed || (k.block.role === 'heading' && k.block.level === 1)) last = k.block.el;
  }
  let next: Element | null = null;
  for (let i = kept.length - 1; i >= 0; i--) {
    const k = kept[i]!;
    const after = next;
    if (k.confirmed) next = k.block.el;
    const start = before[i];
    if (!k.missing || !start || !after) continue;
    const el = k.block.el!;
    if (linkTextRatio(el) < 0.5 && inArticleFlow(el, commonAncestor(start, after))) k.missing = false;
  }
}

interface Kept {
  block: Block;
  /** Only Readability left it out. */
  missing: boolean;
  /** Long enough to check, and Readability kept it: the article is here. */
  confirmed: boolean;
}

/** Nothing from `el` up to `top` is named as something other than the article, nor is a form. */
function inArticleFlow(el: Element, top: Element | null): boolean {
  if (!top || !top.contains(el)) return false;
  for (let at: Element | null = el; at && at !== top; at = at.parentElement) {
    if (NOT_CONTENT.test(namesOf(at))) return false;
    if (at.parentElement === top && at.querySelector('form, input, select, textarea, iframe')) return false;
  }
  return true;
}

function commonAncestor(a: Element, b: Element): Element | null {
  for (let at: Element | null = a; at; at = at.parentElement) if (at.contains(b)) return at;
  return null;
}

/**
 * Inside the page's furniture: a sidebar, the site's header or footer, a navigation box. Not a note
 * among the article's paragraphs (article-asides.ts), nor the article's own header, which holds its
 * title and standfirst rather than the site's name.
 */
function boilerplate(el: Element, root: Element, asides: Map<Element, Element | null>): boolean {
  for (let at: Element | null = el; at; at = at.parentElement) {
    if (at.matches(BOILERPLATE_ANCESTOR) && !partOfArticle(at, root, asides)) return true;
  }
  return false;
}

function partOfArticle(el: Element, root: Element, asides: Map<Element, Element | null>): boolean {
  if (el === root || !root.contains(el)) return false;
  return asideAround(el, root, asides) === el || articleHeader(el, root);
}

/** The article's own `<header>`: inside it, holding its title, on a page whose article was found. */
function articleHeader(el: Element, root: Element): boolean {
  if (el.tagName !== 'HEADER' || root === root.ownerDocument.body) return false;
  if (!el.querySelector('h1, h2, h3') || NOT_CONTENT.test(namesOf(el))) return false;
  // A title and a line or two under it. Wikipedia's title bar is a header too, with the article's
  // name in it and its 300 languages in a menu beside it.
  if (el.querySelector('nav, [role="navigation"], [role="menu"], [aria-haspopup], button, input, select')) return false;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= 800 && linkTextRatio(el) < 0.5;
}
