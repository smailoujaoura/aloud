/**
 * The eleventh pass (AD02): an Arabic sentence whose last word is Latin is evenly made of both
 * directions, and the tie went to left-to-right — "هذا هو اسم التطبيق Aloud." came back as
 * ".Aloud هذا هو اسم التطبيق". The fixture is the reviewer's own Chromium-printed PDF.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { layoutPdfText } from '@/pdf/text-layout';

describe('sentences that end in the other script', () => {
  it('read in their own order and direction, the full stop last', async () => {
    const doc = await getDocument({ data: new Uint8Array(readFileSync('tests/fixtures/pdf/rtl-endings.pdf')) }).promise;
    const page = await doc.getPage(1);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.flatMap((r) =>
      'str' in r
        ? [{ str: r.str, x: r.transform[4]!, y: r.transform[5]!, width: r.width, height: r.height || Math.abs(r.transform[3]!) }]
        : [],
    );
    const blocks = layoutPdfText([{ pageNumber: 1, width, height, items }]).blocks;
    expect(blocks.map((b) => [b.text, b.lines.every((l) => l.rtl)])).toEqual([
      ['هذا هو اسم التطبيق Aloud.', true],
      ['هذا هو ChromiumExtension.', true],
      ['هذا هو ChromiumExtension هنا.', true],
      ['This report mentions محمد سعيد today.', false],
      // No space before the full stop: the gap is measured to the Arabic it follows on the page.
      ['This report mentions محمد سعيد.', false],
      ['هذا هو التقرير رقم ١٢٣.', true],
    ]);
  });
});
