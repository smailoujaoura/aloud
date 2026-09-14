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

/** Headings that open an end-of-article apparatus rather than more of the article. */
const REFERENCE_HEADING =
  /^(references|reference list|notes|notes and references|citations|footnotes|endnotes|bibliography|sources|works cited|further reading|external links|see also)$/i;

/** Footnote and reference lists that are not under such a heading (Wikipedia, DPub-ARIA). */
const REFERENCE_LIST =
  '.references, .reflist, .footnotes, .refbegin, [role="doc-endnotes"], [role="doc-bibliography"], [role="doc-footnote"]';

/** "References[edit]", "Notes ¶", "See also:" — the bare heading underneath. */
export function headingKey(text: string): string {
  return text
    .replace(/\[\s*edit\s*\]/gi, '')
    .replace(/[¶#:§]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function blocksToRead(
  blocks: readonly Block[],
  skip: SkipSettings,
  textOf: (block: Block) => string,
): Block[] {
  const out: Block[] = [];
  /** Heading level of a reference section being skipped, or 0 when none is. */
  let skippingSectionAt = 0;

  for (const block of blocks) {
    const el = block.el;

    if (block.role === 'heading') {
      if (skippingSectionAt && block.level <= skippingSectionAt) skippingSectionAt = 0;
      if (skip.references && REFERENCE_HEADING.test(headingKey(textOf(block)))) {
        skippingSectionAt = block.level || 2;
        continue;
      }
    }
    if (skippingSectionAt) continue;
    if (!el) {
      out.push(block); // the synthetic spoken-only title
      continue;
    }

    if (skip.code && (block.role === 'code' || el.closest('pre'))) continue;
    if (skip.tables && el.closest('table')) continue;
    if (skip.captions && (block.role === 'caption' || el.closest('figcaption'))) continue;
    if (skip.references && el.closest(REFERENCE_LIST)) continue;

    out.push(block);
  }
  return out;
}
