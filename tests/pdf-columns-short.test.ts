/**
 * The tenth pass: a short two-column page. Column detection wanted twelve stretches of text before
 * it would believe in a gutter, so a page with a few lines a column was read as one wide column,
 * and the lines of both columns that shared a baseline were merged, words interleaved.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPdfText, type PdfLineBox } from '@/pdf/text-layout';

async function lines(file: string): Promise<PdfLineBox[]> {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(`tests/fixtures/pdf/${file}`)) }).promise;
  const page = await doc.getPage(1);
  const { width, height } = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.flatMap((r) =>
    'str' in r
      ? [{ str: r.str, x: r.transform[4]!, y: r.transform[5]!, width: r.width, height: r.height || Math.abs(r.transform[3]!) }]
      : [],
  );
  return layoutPdfText([{ pageNumber: 1, width, height, items }]).blocks.flatMap((b) => b.lines);
}

/** No line reaches across the gap: each sits wholly in one half of the page. */
function oneColumnEach(all: PdfLineBox[], gap: number): boolean {
  return all.every((l) => l.x1 <= gap || l.x0 >= gap);
}

describe('a short two-column page', () => {
  it('English: the first column, then the second, nothing merged', async () => {
    const all = await lines('en-cols-short.pdf');
    expect(oneColumnEach(all, 210)).toBe(true);
    const text = all.map((l) => l.text).join('');
    expect(text.indexOf('this column ends.')).toBeLessThan(text.indexOf('The second column starts'));
    expect(text).toContain('The first column starts here and carries on');
  });

  it('Arabic: the right column, then the left, nothing merged', async () => {
    const all = await lines('rtl-cols-short.pdf');
    expect(oneColumnEach(all, 210)).toBe(true);
    expect(all.every((l) => l.rtl)).toBe(true);
    const right = all.findIndex((l) => l.x0 > 210);
    const left = all.findIndex((l) => l.x1 < 210);
    expect(right).toBe(0);
    expect(all.slice(left).every((l) => l.x1 < 210)).toBe(true); // once left, it stays left
  });
});
