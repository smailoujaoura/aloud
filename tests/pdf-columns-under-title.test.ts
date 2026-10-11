/**
 * The thirteenth pass: two columns under full-width text. A title and an intro over a short
 * two-column section were counted as runs crossing the gutter — too many for a gutter to be
 * believed — and the columns were read as one, line by line. And a piece of a full-width line,
 * broken off where the producer split its runs (Chromium does at an "fi" ligature), was read as
 * column text: "stand" stayed in the intro and "first would." went to column two.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPdfText, type PdfBlock } from '@/pdf/text-layout';

async function blocks(file: string): Promise<{ blocks: PdfBlock[]; width: number }> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(`tests/fixtures/pdf/${file}`)) }).promise;
  const page = await doc.getPage(1);
  const { width, height } = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.flatMap((r) =>
    'str' in r
      ? [{ str: r.str, x: r.transform[4]!, y: r.transform[5]!, width: r.width, height: r.height || Math.abs(r.transform[3]!) }]
      : [],
  );
  return { blocks: layoutPdfText([{ pageNumber: 1, width, height, items }]).blocks, width };
}

describe('two columns under a full-width title and intro', () => {
  it('English: title, the intro whole, then the first column, then the second', async () => {
    const { blocks: b } = await blocks('en-title-cols.pdf');
    const text = b.map((x) => x.text);
    expect(text[0]).toBe('A Title Across the Page');
    expect(text[1]).toContain('as an abstract or a standfirst would.');
    const first = text.findIndex((t) => t.startsWith('The first column starts here and continues'));
    const second = text.findIndex((t) => t.startsWith('The second column starts here and carries on'));
    expect(first).toBeGreaterThan(1);
    expect(second).toBeGreaterThan(first);
    expect(text.slice(first, second).every((t) => !/second column/.test(t))).toBe(true);
  });

  it('Arabic: the right column, whole, then the left', async () => {
    const { blocks: b, width } = await blocks('ar-title-cols.pdf');
    const columns = b.slice(2).flatMap((x) => x.lines);
    expect(columns.every((l) => l.x1 < width / 2 || l.x0 > width / 2)).toBe(true);
    const firstLeft = columns.findIndex((l) => l.x1 < width / 2);
    expect(columns.slice(0, firstLeft).every((l) => l.x0 > width / 2)).toBe(true);
    expect(columns.slice(firstLeft).every((l) => l.x1 < width / 2)).toBe(true);
  });

  it('a realistic paper: title, abstract, then all twelve paragraphs in order', async () => {
    const { blocks: b } = await blocks('paper-two-columns.pdf');
    // A paragraph may run on from the foot of one column to the head of the next.
    const text = b.map((x) => x.text).join(' ¶ ').replace(/ ¶ (?=[a-z])/g, ' ');
    expect(text).toMatch(/^A Realistic Paper Title Set Across Both Columns ¶ Abstract\. This abstract/);
    const order = [...text.matchAll(/Paragraph (\d+) of the paper has [^¶]*?and ends here\./g)].map((m) => Number(m[1]));
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
