/**
 * What *not* to read aloud.
 *
 * Some parts of an article are for looking at, not listening to: a code listing read symbol by
 * symbol, a table read cell by cell with no way to tell the columns apart, the forty-entry
 * reference list under a Wikipedia article. Each can be skipped on its own, and skipped blocks are
 * simply left out of the plan — the page keeps them, only the voice passes over them.
 *
 * Applied to a whole-article read only. A selection, or "Read from here" on a code block, is an
 * explicit request to hear exactly that.
 */
import type { Block } from '@/extract/block-model';
import type { SkipSettings } from '@/shared/settings';
import { apparatusText, endSectionHeading, rulesFor, skipSelector, SKIP_MARK, type Category, type PageRules } from '@/extract/site-rules';

/** Headings that open an end-of-article apparatus rather than more of the article. */
const REFERENCE_HEADING =
  /^(references|reference list|notes|notes and references|citations|footnotes|endnotes|bibliography|sources|works cited|further reading|external links|see also)$/i;

/** Footnote and reference lists that are not under such a heading (Wikipedia, DPub-ARIA). */
const REFERENCE_LIST =
  '.references, .reflist, .footnotes, .refbegin, [role="doc-endnotes"], [role="doc-bibliography"], [role="doc-footnote"]';

/** "References[edit]", "Note[modifica | modifica wikitesto]", "Notes ¶", "See also:" — the bare heading. */
export function headingKey(text: string): string {
  return text
    .replace(/\[[^\]]*\]\s*$/g, '')
    .replace(/[¶#:§]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function blocksToRead(
  blocks: readonly Block[],
  skip: SkipSettings,
  textOf: (block: Block) => string,
  rules?: PageRules,
): Block[] {
  const out: Block[] = [];
  /** Heading level of a reference section being skipped, or 0 when none is. */
  let skippingSectionAt = 0;

  for (const block of blocks) {
    const el = block.el;

    if (block.role === 'heading') {
      if (skippingSectionAt && block.level <= skippingSectionAt) skippingSectionAt = 0;
      const key = headingKey(textOf(block));
      if ((skip.references && REFERENCE_HEADING.test(key)) || (rules && endSectionHeading(rules, skip, key))) {
        skippingSectionAt = block.level || 2;
        continue;
      }
    }
    if (skippingSectionAt) continue;
    if (!el) {
      out.push(block); // the synthetic spoken-only title
      continue;
    }
    // "Was this page helpful?", "5 min read", "Share this:": apparatus by its words alone.
    if (rules && apparatusText(rules, textOf(block))) continue;

    if (skip.code && (block.role === 'code' || el.closest('pre'))) continue;
    if (skip.tables && el.closest('table')) continue;
    if (skip.captions && (block.role === 'caption' || el.closest('figcaption'))) continue;
    if (skip.references && el.closest(REFERENCE_LIST)) continue;

    out.push(block);
  }
  return out;
}

const HEADING_LEVEL: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

/**
 * How many characters a whole-article read of `root` would say, under the same skip rules as
 * `blocksToRead` — for estimates made away from the live page (the queue's "about 12 min"), where
 * there is no layout to build blocks from. Counting all the text counted the reference list, the
 * notes and the navigation boxes under a Wikipedia article: an hour for a twenty-minute read.
 */
export function readableLength(root: Element, skip: SkipSettings, rules?: PageRules): number {
  const doc = root.ownerDocument;
  const never = rules ? skipSelector(rules, skip) : '';
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let chars = 0;
  let skippingAt = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const level = HEADING_LEVEL[el.tagName];
      if (level) {
        if (skippingAt && level <= skippingAt) skippingAt = 0;
        const key = headingKey(el.textContent ?? '');
        if ((skip.references && REFERENCE_HEADING.test(key)) || (rules && endSectionHeading(rules, skip, key))) skippingAt = level;
      }
      continue;
    }
    if (skippingAt) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, noscript, template')) continue;
    if (skip.references && parent.closest(`${REFERENCE_LIST}, sup.reference, .mw-editsection`)) continue;
    if (never && parent.closest(never)) continue;
    if (skip.code && parent.closest('pre')) continue;
    if (skip.tables && parent.closest('table')) continue;
    if (skip.captions && parent.closest('figcaption, caption')) continue;
    chars += (node.nodeValue ?? '').replace(/\s+/g, ' ').length;
  }
  return chars;
}

/**
 * Before a page is saved for later (the reading queue), mark on the copy what this page's rules
 * would leave unread — citation markers, infoboxes, the reference list and everything under
 * "References" — with why (SKIP_MARK). Read later from the copy, a saved Wikipedia article said
 * 190 "[12]"s and ended on its bibliography: the copy had lost the classes the rules look for, and
 * the "References" heading itself.
 *
 * `copyOf` maps an element of the live page to its copy, which may have been removed already.
 */
export function markUnread(live: Document, copyOf: (el: Element) => Element | undefined, url?: string): void {
  const rules = rulesFor(live, url);
  const marks = new Map<Element, Set<Category>>();
  const mark = (el: Element, why: Category): void => {
    const set = marks.get(el) ?? new Set<Category>();
    set.add(why);
    marks.set(el, set);
  };
  const selectors: Record<Category, string[]> = {
    ...rules.skip,
    references: [...rules.skip.references, REFERENCE_LIST, 'sup.reference'],
  };
  for (const why of Object.keys(selectors) as Category[]) {
    for (const selector of selectors[why]) {
      try {
        live.querySelectorAll(selector).forEach((el) => mark(el, why));
      } catch {
        /* a selector this browser cannot parse */
      }
    }
  }

  // End sections: the heading, and everything after it up to the next heading of its level.
  const body = live.body;
  if (body) {
    const headings = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    const all = [...body.querySelectorAll('*')];
    headings.forEach((heading, i) => {
      const key = headingKey(heading.textContent ?? '');
      const why: Category | null = REFERENCE_HEADING.test(key) ? 'references' : (rules.sections.find((s) => s.re.test(key))?.as ?? null);
      if (!why) return;
      const level = HEADING_LEVEL[heading.tagName] ?? 2;
      const stop = headings.slice(i + 1).find((h) => (HEADING_LEVEL[h.tagName] ?? 2) <= level) ?? null;
      const inSection = (el: Element): boolean =>
        !!(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !heading.contains(el) &&
        (!stop || (!!(el.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(stop)));
      mark(heading, why);
      for (const el of all) {
        // Only the outermost: a mark covers what is inside it.
        if (inSection(el) && !(el.parentElement && inSection(el.parentElement))) mark(el, why);
      }
    });
  }

  for (const [el, why] of marks) copyOf(el)?.setAttribute(SKIP_MARK, [...why].join(' '));
}
