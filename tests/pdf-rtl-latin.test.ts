/**
 * The ninth recheck (AC03): a long Latin name inside an Arabic sentence used to outvote the
 * Arabic around it and turn the whole line left to right — the words came back in reverse with
 * the full stop at the front.
 *
 * The fixture's font loses a few glyph mappings when the text is extracted (they come back as
 * U+0000), so the assertions are about word order and where the full stop lands. That is exactly
 * what the fault corrupted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPdfText } from '@/pdf/text-layout';

/** The line's words, with the fixture's unmapped glyphs dropped. */
const words = (text: string): string[] =>
  text
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');

describe('a long Latin name in an Arabic PDF line', () => {
  it('does not turn the sentence round, however long the name is', async () => {
    const doc = await getDocument({ data: new Uint8Array(readFileSync('tests/fixtures/pdf/rtl-latin.pdf')) }).promise;
    const page = await doc.getPage(1);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap((r) =>
      'str' in r
        ? [{ str: r.str, x: r.transform[4]!, y: r.transform[5]!, width: r.width, height: r.height || Math.abs(r.transform[3]!) }]
        : [],
    );
    const blocks = layoutPdfText([{ pageNumber: 1, width, height, items }]).blocks;

    // The long name and the short one must behave the same: both sentences are Arabic, the name
    // sits inside them, and the full stop ends the sentence instead of leading it.
    const ARABIC = /[\u0600-\u06FF\uFB50-\uFEFF]/;
    for (const name of ['ChromiumExtension', 'Aloud']) {
      const block = blocks.find((b) => b.text.includes(name))!;
      const text = block.text.trim();
      expect(block.lines.every((l) => l.rtl), name).toBe(true);
      expect(text.endsWith('.'), name).toBe(true);
      expect(text.startsWith('.'), name).toBe(false);
      const at = text.indexOf(name);
      expect(ARABIC.test(text.slice(0, at)), `Arabic before ${name}`).toBe(true);
      expect(ARABIC.test(text.slice(at + name.length)), `Arabic after ${name}`).toBe(true);
    }

    // An English sentence with Arabic names in it keeps its own direction and order.
    const english = blocks.find((b) => b.text.startsWith('This'))!;
    expect(english.lines.some((l) => l.rtl)).toBe(false);
    expect(words(english.text).slice(0, 3)).toEqual(['This', 'report', 'mentions']);
    expect(words(english.text).at(-1)).toBe('today.');

    // A brand name and a price in one Arabic line: neither decides the direction, and the
    // number keeps its own left-to-right order where it stands.
    const price = blocks.find((b) => b.text.includes('BlackBerry'))!;
    expect(price.lines.every((l) => l.rtl)).toBe(true);
    expect(price.text).toContain('BlackBerryInternational');
    expect(price.text).toContain('1200');
    expect(price.text.trim().endsWith('.')).toBe(true);
  });
});
