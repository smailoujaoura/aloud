/**
 * Article extraction with @mozilla/readability.
 *
 * Readability MUTATES the document it is given, so we always hand it a clone. Its output is a
 * sanitised, detached HTML string whose character offsets do NOT map back to the live DOM — so
 * we only use it for *what to read* (clean text, correct order). *Where to highlight* is
 * resolved separately against the live DOM (see live-container.ts + fuzzy-align.ts).
 */
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { markUnread } from '@/content/skip-rules';
import { Eligibility, invisible, revealPending } from './eligibility';

/**
 * Prune Readability's copy of the page using what the *live* page shows. The copy has lost the
 * site's stylesheets, so it cannot tell a collapsed translation from prose, or a styled "Translate?"
 * div from a paragraph. Controls always go. Hidden content goes when the copy is what is kept
 * (`forSaving`): read live, it stays a candidate, read when revealed (content/playlist.ts).
 * Elements are paired by document order, which `cloneNode` preserves.
 */
function pruneCopy(live: Document, copy: Document, forSaving: boolean, url?: string): void {
  const liveEls = live.documentElement.querySelectorAll('*');
  const copyEls = copy.documentElement.querySelectorAll('*');
  if (liveEls.length !== copyEls.length) return; // the page changed under us: prune nothing
  const check = new Eligibility();
  const drop: Element[] = [];
  const blank: Element[] = [];
  // What the page's rules would not read is marked now, while there is a page to apply them to.
  if (forSaving) {
    const index = new Map<Element, number>();
    liveEls.forEach((el, i) => index.set(el, i));
    markUnread(
      live,
      (el) => {
        const i = index.get(el);
        return i == null ? undefined : copyEls[i];
      },
      url,
    );
  }
  liveEls.forEach((el, i) => {
    if (check.control(el) || (forSaving && el.ownerDocument.defaultView && check.hidden(el))) drop.push(copyEls[i]!);
    // `visibility: hidden` is inherited but can be undone below: the element's own text goes, and a
    // child that makes itself visible again stays.
    else if (forSaving && el.ownerDocument.defaultView && invisible(el) && !revealPending(el)) {
      const shown = [...el.querySelectorAll('*')].some((d) => !invisible(d));
      if (shown) blank.push(copyEls[i]!);
      else drop.push(copyEls[i]!);
    }
  });
  for (const el of blank) for (const n of [...el.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove();
  for (const el of drop) el.remove();
  // A wiki's "[edit]" link beside every heading made Readability take the heading for link clutter
  // and drop it: a saved Wikipedia article had no section titles. Never read, never needed.
  if (forSaving) for (const el of copy.querySelectorAll('.mw-editsection, .editsection')) el.remove();
  // Read live, hidden prose stays a candidate (a disclosure may reveal it), so Readability must see
  // it: it skips anything marked `hidden` or `aria-hidden`, and the reader only plans what
  // Readability kept. The live page decides what is read now (extract/eligibility.ts).
  if (!forSaving) {
    for (const el of copy.querySelectorAll('[hidden], [aria-hidden="true"]')) {
      el.removeAttribute('hidden');
      el.removeAttribute('aria-hidden');
    }
  }
  // Text a scroll-reveal library hides with `visibility` until scrolled to (WOW.js) is content:
  // Readability drops it otherwise, saving or reading.
  liveEls.forEach((el, i) => {
    if (el instanceof HTMLElement && el.style.visibility === 'hidden' && revealPending(el)) (copyEls[i] as HTMLElement).style.removeProperty('visibility');
  });
}

export interface ExtractedArticle {
  title: string;
  /** Plain text of the article body, newline-separated between blocks. */
  text: string;
  /** Language hint from <html lang> or Readability. */
  lang: string;
  /** Byline / author if detected. */
  byline: string | null;
  /** Sanitised HTML (used for the reader-mode fallback view only). */
  html: string;
  /** True when the page looked like a real article. */
  readerable: boolean;
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
  'ARTICLE', 'SECTION', 'FIGCAPTION', 'DD', 'DT', 'TD', 'TH', 'TR', 'UL', 'OL',
  'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'BR', 'HR', 'TABLE',
]);

/** Flatten an element's visible text, inserting "\n" at block boundaries. Mirrors text-index. */
export function elementToText(root: Element, check?: Eligibility): string {
  const parts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.currentNode;
  let lastWasBlock = true;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
        node = skipSubtree(walker);
        continue;
      }
      // On a live page: not hidden text, not a control's label.
      if (check && (check.control(node as Element) || ((node as Element).ownerDocument.defaultView && (check.hidden(node as Element) || invisible(node as Element))))) {
        node = skipSubtree(walker);
        continue;
      }
      if (BLOCK_TAGS.has(tag) && !lastWasBlock) {
        parts.push('\n');
        lastWasBlock = true;
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue ?? '';
      if (t.trim()) {
        parts.push(t);
        lastWasBlock = false;
      }
    }
    node = walker.nextNode();
  }
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function skipSubtree(walker: TreeWalker): Node | null {
  const current = walker.currentNode;
  let n = walker.nextNode();
  while (n && (current.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
    n = walker.nextNode();
  }
  return n;
}

/**
 * `forSaving`: the article is kept for later (the reading queue): only what shows now is kept, and
 * what the site's rules would not read is marked (content/skip-rules.ts: markUnread). `url`: where
 * the document came from, when it is not its own address (a downloaded page).
 */
export function extractArticle(doc: Document = document, opts: { forSaving?: boolean; url?: string } = {}): ExtractedArticle {
  const readerable = safeIsReaderable(doc);
  const lang =
    doc.documentElement.getAttribute('lang')?.trim().split('-')[0] ||
    doc.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content')?.split(',')[0]?.trim() ||
    'en';

  let title = doc.title;
  let text = '';
  let byline: string | null = null;
  let html = '';

  try {
    const clone = doc.cloneNode(true) as Document;
    pruneCopy(doc, clone, opts.forSaving === true, opts.url);
    const article = new Readability(clone, {
      charThreshold: 250,
      keepClasses: false,
    }).parse();
    if (article) {
      title = article.title || title;
      byline = article.byline ?? null;
      html = article.content ?? '';
      text = (article.textContent ?? '').replace(/\n{2,}/g, '\n').trim();
    }
  } catch {
    // fall through to the heuristic below
  }

  if (!text || text.length < 200) {
    // Readability bailed (docs pages, wikis, forums). Fall back to the largest sensible block.
    const container = pickLargestTextBlock(doc);
    if (container) text = elementToText(container, new Eligibility());
  }

  return { title: title.trim(), text, lang, byline, html, readerable };
}

function safeIsReaderable(doc: Document): boolean {
  try {
    return isProbablyReaderable(doc, { minContentLength: 140 });
  } catch {
    return false;
  }
}

function pickLargestTextBlock(doc: Document): Element | null {
  const candidates = doc.querySelectorAll('main, article, [role="main"], #content, .content, .post, .article, .markdown-body, body');
  let best: Element | null = null;
  let bestScore = 0;
  candidates.forEach((el) => {
    if (el.closest('nav, aside, header, footer')) return;
    const len = (el.textContent ?? '').trim().length;
    const linkDensity = linkTextRatio(el);
    const score = len * (1 - Math.min(linkDensity, 0.9));
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  });
  return best;
}

function linkTextRatio(el: Element): number {
  const total = (el.textContent ?? '').length || 1;
  let linkLen = 0;
  el.querySelectorAll('a').forEach((a) => (linkLen += (a.textContent ?? '').length));
  return linkLen / total;
}
