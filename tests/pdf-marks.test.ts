import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  MarkHistory,
  importAnnotations,
  inReadingOrder,
  markAt,
  mergeLineBoxes,
  recolorForKind,
  toneFor,
  type Box,
  type Mark,
} from '@/pdf/annotations/model';
import { withMarks, withoutMarks, pdfDate } from '@/pdf/annotations/pdf-writer';

function mark(over: Partial<Mark> = {}): Mark {
  return {
    id: over.id ?? Math.random().toString(16).slice(2),
    page: 1,
    kind: 'highlight',
    color: toneFor('highlight', 'yellow'),
    boxes: [[50, 195, 250, 218]],
    text: 'Hello annotated world',
    note: '',
    created: 1000,
    updated: 1000,
    ...over,
  };
}

/** A one-page PDF with text, a link, and (optionally) a highlight from "another app". */
async function samplePdf(withForeignHighlight = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawText('Hello annotated world', { x: 50, y: 200, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
  const ctx = doc.context;
  const annots = [
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0] })),
  ];
  if (withForeignHighlight) {
    const hl = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [50, 195, 250, 218],
        QuadPoints: [50, 218, 250, 218, 50, 195, 250, 195],
        C: [1, 1, 0],
        Contents: PDFString.of('from acrobat'),
      }),
    );
    const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [260, 200, 380, 280], Parent: hl }));
    annots.push(hl, popup);
  }
  page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  return doc.save();
}

async function annotationsOf(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const page = await (await task.promise).getPage(1);
  const list = await page.getAnnotations();
  await task.destroy();
  return list as Array<Record<string, any>>;
}

describe('mergeLineBoxes', () => {
  it('joins runs on one line and keeps separate lines apart', () => {
    const boxes: Box[] = [
      [10, 100, 60, 112],
      [60.5, 100.2, 120, 111.8],
      [10, 85, 90, 97],
      [0, 0, 0, 5], // empty
    ];
    expect(mergeLineBoxes(boxes)).toEqual([
      [10, 100, 120, 112],
      [10, 85, 90, 97],
    ]);
  });

  it('does not join two columns that share a baseline', () => {
    expect(mergeLineBoxes([[10, 100, 100, 112], [300, 100, 390, 112]])).toHaveLength(2);
  });
});

describe('marks', () => {
  it('finds the newest mark under a point', () => {
    const older = mark({ id: 'a', created: 1 });
    const newer = mark({ id: 'b', created: 2 });
    expect(markAt([older, newer], 1, 100, 200)?.id).toBe('b');
    expect(markAt([older, newer], 2, 100, 200)).toBeNull();
    expect(markAt([older], 1, 100, 250)).toBeNull();
  });

  it('orders marks by page, then top to bottom', () => {
    const low = mark({ id: 'low', boxes: [[10, 10, 50, 20]] });
    const high = mark({ id: 'high', boxes: [[10, 200, 50, 210]] });
    const p2 = mark({ id: 'p2', page: 2, boxes: [[10, 250, 50, 260]] });
    expect(inReadingOrder([p2, low, high]).map((m) => m.id)).toEqual(['high', 'low', 'p2']);
  });

  it('switches palette tone with the kind, and leaves foreign colours alone', () => {
    expect(recolorForKind(mark(), 'underline')).toBe(toneFor('underline', 'yellow'));
    expect(recolorForKind(mark({ color: '#123456' }), 'strike')).toBe('#123456');
  });

  it('undoes and redoes, with a note typed as a single step', () => {
    const h = new MarkHistory();
    h.add(mark({ id: 'x' }));
    h.checkpoint();
    h.amend('x', { note: 'h' });
    h.amend('x', { note: 'hello' });
    expect(h.marks[0]!.note).toBe('hello');
    h.undo();
    expect(h.marks[0]!.note).toBe('');
    h.undo();
    expect(h.marks).toHaveLength(0);
    h.redo();
    h.redo();
    expect(h.marks[0]!.note).toBe('hello');
    h.remove('x');
    expect(h.marks).toHaveLength(0);
    expect(h.canRedo).toBe(false);
  });
});

describe('writing marks into the PDF', () => {
  it('writes standard annotations every viewer can read, and keeps other annotations', async () => {
    const bytes = await withMarks(await samplePdf(), [
      mark({ id: 'h1', note: 'Café — naïve ✓' }),
      mark({ id: 'u1', kind: 'underline', color: toneFor('underline', 'blue'), boxes: [[50, 150, 200, 165], [50, 130, 120, 145]] }),
      mark({ id: 's1', kind: 'strike', color: toneFor('strike', 'pink') }),
      mark({ id: 'n1', kind: 'note', boxes: [[300, 250, 320, 270]], note: 'sticky' }),
      mark({ id: 'gone', page: 9 }), // no such page: skipped, not an error
    ]);
    const list = await annotationsOf(bytes);
    const types = list.map((a) => a.subtype).sort();
    expect(types).toEqual(['Highlight', 'Link', 'StrikeOut', 'Text', 'Underline']);

    const hl = list.find((a) => a.subtype === 'Highlight')!;
    expect(hl.contentsObj.str).toBe('Café — naïve ✓');
    expect(Array.from(hl.quadPoints)).toEqual([50, 218, 250, 218, 50, 195, 250, 195]);
    expect(hl.hasAppearance).toBe(true);

    const ul = list.find((a) => a.subtype === 'Underline')!;
    expect(ul.quadPoints).toHaveLength(16);

    // Round trip: what was written comes back as the same marks.
    const back = importAnnotations(1, list as never);
    expect(back.map((m) => m.kind).sort()).toEqual(['highlight', 'note', 'strike', 'underline']);
    const blue = back.find((m) => m.kind === 'underline')!;
    expect(blue.color).toBe(toneFor('underline', 'blue'));
    expect(blue.boxes).toEqual([[50, 150, 200, 165], [50, 130, 120, 145]]);
  });

  it('replaces marks on a second save instead of piling them up', async () => {
    const once = await withMarks(await samplePdf(), [mark({ id: 'a' }), mark({ id: 'b' })]);
    const twice = await withMarks(once, [mark({ id: 'a' })]);
    const list = await annotationsOf(twice);
    expect(list.filter((a) => a.subtype === 'Highlight')).toHaveLength(1);
    expect(list.filter((a) => a.subtype === 'Link')).toHaveLength(1);
  });

  it('strips highlights made elsewhere, with their pop-ups, for editing', async () => {
    const original = await samplePdf(true);
    const before = await annotationsOf(original);
    const imported = importAnnotations(1, before as never);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.note).toBe('from acrobat');

    const stripped = await withoutMarks(original);
    expect(stripped).not.toBeNull();
    expect((await annotationsOf(stripped!)).map((a) => a.subtype)).toEqual(['Link']);
    expect(await withoutMarks(await samplePdf(false))).toBeNull();
  });

  it('formats dates the way PDF expects', () => {
    expect(pdfDate(Date.UTC(2026, 8, 4, 7, 5, 3))).toBe('D:20260904070503Z');
  });
});
