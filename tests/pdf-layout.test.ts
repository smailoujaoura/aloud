import { describe, it, expect } from 'vitest';
import { layoutPdfText, titleIsInBody, type PdfPageInput, type PdfTextItem } from '@/pdf/text-layout';

/**
 * The tests build pages the way a PDF producer does: a baseline per line, x for the left edge,
 * height for the font size. y grows *up*, so a line lower on the page has a smaller y.
 */
const PAGE_W = 612;
const PAGE_H = 792;

interface LineSpec {
  text: string;
  y: number;
  x?: number;
  size?: number;
  font?: string;
}

function line({ text, y, x = 72, size = 11, font = 'F1' }: LineSpec): PdfTextItem {
  return { str: text, x, y, width: text.length * size * 0.5, height: size, fontName: font };
}

function page(pageNumber: number, lines: LineSpec[]): PdfPageInput {
  return { pageNumber, width: PAGE_W, height: PAGE_H, items: lines.map(line) };
}

describe('layoutPdfText', () => {
  /**
   * The page-image view draws one invisible span per line over the rendered page, so the line
   * pieces must reassemble into exactly the text that is spoken — separators and all.
   */
  it('gives every block line boxes that concatenate back into its text', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'Candidates will be notified by email within four weeks of the inter-', y: 700 },
        { text: 'view. Questions may be addressed to the admissions office.', y: 684 },
      ]),
    ]);

    const block = out.blocks[0]!;
    expect(block.lines.map((l) => l.text).join('')).toBe(block.text);
    expect(block.lines).toHaveLength(2);
    expect(block.lines[0]!.text).toMatch(/inter$/); // hyphen dropped, no separator added
    expect(block.lines[0]!.y).toBe(700);
    expect(block.lines[1]!.y).toBe(684);
  });

  it('keeps the line boxes of a list item after the marker is dropped', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'The requirements are as follows and they are strict.', y: 700 },
        { text: '• A bachelor degree in a relevant field', y: 660 },
      ]),
    ]);

    const item = out.blocks.find((b) => b.kind === 'list-item')!;
    expect(item.lines.map((l) => l.text).join('')).toBe(item.text);
    expect(item.lines[0]!.x0).toBe(72);
  });

  it('merges wrapped lines into one paragraph and repairs hyphenated words', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'Candidates will be notified by email within four weeks of the inter-', y: 700 },
        { text: 'view. Questions may be addressed to the admissions office.', y: 684 },
      ]),
    ]);

    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0]!.kind).toBe('paragraph');
    expect(out.blocks[0]!.text).toBe(
      'Candidates will be notified by email within four weeks of the interview. ' +
        'Questions may be addressed to the admissions office.',
    );
  });

  it('starts a new paragraph on a wide vertical gap', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'First paragraph, first line of it.', y: 700 },
        { text: 'Still the first paragraph here.', y: 684 },
        { text: 'A second paragraph starts here.', y: 640 },
      ]),
    ]);

    expect(out.blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph']);
    expect(out.blocks[0]!.text).toContain('Still the first paragraph');
    expect(out.blocks[1]!.text).toBe('A second paragraph starts here.');
  });

  it('reads a headed document as heading + body, and titles it from the biggest heading', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'Small print at the very top of the page.', y: 760, size: 8 },
        { text: 'Call for Applications 2026', y: 720, size: 20 },
        { text: 'Eligibility', y: 660, size: 16 },
        { text: 'Applicants must hold a degree in a relevant field.', y: 630 },
      ]),
    ]);

    expect(out.title).toBe('Call for Applications 2026');
    const headings = out.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
    expect(headings).toContain('Call for Applications 2026');
    expect(headings).toContain('Eligibility');
  });

  it('treats a numbered section line as a heading even at body size', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'Some introductory prose that fills the page nicely.', y: 700 },
        { text: '3.2 Attention', y: 660 },
        { text: 'An attention function maps a query to an output.', y: 630 },
      ]),
    ]);

    const heading = out.blocks.find((b) => b.text === '3.2 Attention');
    expect(heading?.kind).toBe('heading');
    expect(heading?.level).toBe(2);
  });

  it('drops running headers and page numbers, but keeps body text', () => {
    const makePage = (n: number): PdfPageInput =>
      page(n, [
        { text: 'Annual Report 2026', y: 760, size: 9 },
        { text: `Body text unique to page ${n} that should survive.`, y: 600 },
        { text: String(n), y: 40, size: 9 },
      ]);

    const out = layoutPdfText([makePage(1), makePage(2), makePage(3)]);

    expect(out.blocks.map((b) => b.text)).toEqual([
      'Body text unique to page 1 that should survive.',
      'Body text unique to page 2 that should survive.',
      'Body text unique to page 3 that should survive.',
    ]);
  });

  it('reads two columns down each column, not across the gutter', () => {
    // Both columns share every baseline, exactly as pdf.js reports a real two-column page —
    // which is why the columns have to be resolved before lines are formed.
    const left = [
      'Left column line one of the article',
      'Left column line two of the article',
      'Left column line three of the text',
      'Left column line four of the text',
      'Left column line five of the text',
      'Left column line six of the text',
      'Left column line seven of text',
    ];
    const right = [
      'Right column line one of the article',
      'Right column line two of the article',
      'Right column line three of text',
      'Right column line four of text',
      'Right column line five of text',
      'Right column line six of text',
      'Right column line seven of text',
    ];
    const lines: LineSpec[] = [];
    left.forEach((text, i) => lines.push({ text, y: 700 - i * 16, x: 60, size: 10 }));
    right.forEach((text, i) => lines.push({ text, y: 700 - i * 16, x: 330, size: 10 }));

    const out = layoutPdfText([page(1, lines)]);
    const text = out.blocks.map((b) => b.text).join(' ');

    expect(text.indexOf('Left column line four')).toBeLessThan(text.indexOf('Right column line one'));
  });

  it('turns bullets into list items without the marker', () => {
    const out = layoutPdfText([
      page(1, [
        { text: 'The requirements are as follows and they are strict.', y: 700 },
        { text: '• A bachelor degree in a relevant field', y: 660 },
        { text: '• Proficiency in written English', y: 640 },
      ]),
    ]);

    const items = out.blocks.filter((b) => b.kind === 'list-item');
    expect(items.map((b) => b.text)).toEqual([
      'A bachelor degree in a relevant field',
      'Proficiency in written English',
    ]);
  });

  it('drops superscript footnote markers so they are not spoken', () => {
    const items: PdfTextItem[] = [
      { str: 'Ashish Vaswani', x: 72, y: 700, width: 70, height: 10, fontName: 'F1' },
      { str: '∗', x: 143, y: 704, width: 4, height: 7, fontName: 'F2' },
    ];
    const out = layoutPdfText([{ pageNumber: 1, width: PAGE_W, height: PAGE_H, items }]);

    expect(out.blocks[0]!.text).toBe('Ashish Vaswani');
  });

  it('prefers a usable metadata title and ignores producer junk', () => {
    const pages = [page(1, [{ text: 'Heading Of The Document', y: 720, size: 18 }])];

    expect(layoutPdfText(pages, { metadataTitle: 'A Proper Title' }).title).toBe('A Proper Title');
    expect(layoutPdfText(pages, { metadataTitle: 'Microsoft Word - final(3).doc' }).title).toBe(
      'Heading Of The Document',
    );
  });

  it('returns nothing for a page with no text, rather than throwing', () => {
    const out = layoutPdfText([{ pageNumber: 1, width: PAGE_W, height: PAGE_H, items: [] }]);
    expect(out.blocks).toEqual([]);
    expect(out.title).toBe('PDF document');
  });
});

describe('titleIsInBody', () => {
  const blocks = [
    { text: 'Annual Report 2025' },
    { text: 'Revenue grew by a tenth. Costs were flat.' },
  ];

  it('recognises a title lifted from a heading on the page', () => {
    expect(titleIsInBody('Annual Report 2025', blocks)).toBe(true);
  });

  it('recognises the fallback title, a slice of the opening text', () => {
    const body = [{ text: 'Paragraph 1 says something about the smoke test. It goes on for a while.' }];
    expect(titleIsInBody('Paragraph 1 says something about the smoke test.', body)).toBe(true);
  });

  it('ignores whitespace and case differences', () => {
    expect(titleIsInBody('annual   report\n2025', blocks)).toBe(true);
  });

  it('treats a metadata title that appears nowhere as needing its own heading', () => {
    expect(titleIsInBody('Q4 Board Pack (confidential)', blocks)).toBe(false);
  });
});
