/**
 * The second review's right-to-left finding: a PDF draws every line left to right, and Aloud read
 * Arabic, Persian and Hebrew lines in that order — letters reversed, lines cut into pieces.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPdfText, type PdfTextItem } from '@/pdf/text-layout';

/** A line drawn as one run per word, as most producers do, placed right to left from `right`. */
function rtlWords(words: string[], y: number, right = 500, w = 30, gap = 6): PdfTextItem[] {
  let x = right;
  return words.map((str) => {
    x -= w;
    const run = { str, x, y, width: w, height: 12 };
    x -= gap;
    return run;
  });
}
const page = (items: PdfTextItem[]) => [{ pageNumber: 1, width: 600, height: 800, items }];

describe('right-to-left PDF text', () => {
  it('a Chromium-printed PDF, one glyph per run: Arabic, Persian and English in order, as written', async () => {
    const doc = await getDocument({ data: new Uint8Array(readFileSync('tests/fixtures/pdf/rtl-mixed.pdf')) }).promise;
    const p = await doc.getPage(1);
    const { width, height } = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    const items = content.items.flatMap((r) =>
      'str' in r ? [{ str: r.str, x: r.transform[4], y: r.transform[5], width: r.width, height: r.height || Math.abs(r.transform[3]) }] : [],
    );
    const blocks = layoutPdfText([{ pageNumber: 1, width, height, items }]).blocks;
    expect(blocks.map((b) => b.text)).toEqual([
      'جلست مع أخيه الكبير في المكتبة وقرأنا كتابا عن تاريخ المدينة.',
      'This English line sits between the two right-to-left paragraphs.',
      'امروز هوا خیلی خوب است و ما به پارک رفتیم.',
      'العدد 2024 كان عاما طيبا، وقرأت كتاب Python هناك.',
      'هذه فقرة طويلة بما يكفي لكي تلتف على أكثر من سطر واحد في الصفحة، حتى نرى أن الأسطر تقرأ بالترتيب الصحيح من الأعلى إلى الأسفل ومن اليمين إلى اليسار دون أن تختلط الكلمات.',
    ]);
    expect(blocks.map((b) => b.lines.every((l) => !!l.rtl))).toEqual([true, false, true, true, true]);
  });

  it('whole-word runs: a Hebrew line reads from the right', () => {
    const blocks = layoutPdfText(page(rtlWords(['שלום', 'לכולם', 'כאן'], 700))).blocks;
    expect(blocks[0]!.text).toBe('שלום לכולם כאן');
  });

  it('an English word and a number inside an Arabic line keep their own order', () => {
    // Drawn left to right: "هنا" "Aloud" "1.0" "نسخة" — read from the right: نسخة 1.0 Aloud هنا.
    const items = [
      { str: 'هنا', x: 100, y: 700, width: 30, height: 12 },
      { str: 'Aloud', x: 136, y: 700, width: 40, height: 12 },
      { str: '1.0', x: 182, y: 700, width: 20, height: 12 },
      { str: 'نسخة', x: 208, y: 700, width: 30, height: 12 },
    ];
    expect(layoutPdfText(page(items)).blocks[0]!.text).toBe('نسخة Aloud 1.0 هنا');
  });

  it('an Arabic name inside an English line is turned round, the English left as it is', () => {
    const items = [
      { str: 'Written', x: 100, y: 700, width: 50, height: 12 },
      { str: 'by', x: 156, y: 700, width: 15, height: 12 },
      { str: 'سمير', x: 177, y: 700, width: 30, height: 12 },
      { str: 'أحمد', x: 213, y: 700, width: 30, height: 12 },
      { str: 'today.', x: 249, y: 700, width: 40, height: 12 },
    ];
    expect(layoutPdfText(page(items)).blocks[0]!.text).toBe('Written by أحمد سمير today.');
  });

  it('two Arabic paragraphs, the first ending short on the left, stay two', () => {
    const items = [...rtlWords(['أولا', 'نقرأ', 'هذا.'], 700, 500), ...rtlWords(['ثم', 'هذا', 'بعده', 'هنا', 'أيضا'], 686, 480)];
    const texts = layoutPdfText(page(items)).blocks.map((b) => b.text);
    expect(texts).toEqual(['أولا نقرأ هذا.', 'ثم هذا بعده هنا أيضا']);
  });
});
