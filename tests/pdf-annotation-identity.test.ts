/**
 * The recheck's R06: saving rewrote another reviewer's untouched sticky note as authored by
 * "Aloud", dated today. Built with real pdf-lib bytes, read back the same way.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { importAnnotations } from '@/pdf/annotations/model';
import { withMarks } from '@/pdf/annotations/pdf-writer';

async function reviewed() {
  const d = await PDFDocument.create();
  const p = d.addPage();
  const ref = d.context.register(
    d.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [10, 10, 30, 30],
      F: 12,
      T: PDFString.of('Original reviewer'),
      NM: PDFString.of('their-id'),
      CreationDate: PDFString.of('D:20200101000000Z'),
      M: PDFString.of('D:20200102000000Z'),
      Contents: PDFString.of('Keep this review'),
    }),
  );
  p.node.set(PDFName.of('Annots'), d.context.obj([ref]));
  // What pdf.js reports for that annotation.
  const seen = {
    annotationType: 1,
    rect: [10, 10, 30, 30],
    contentsObj: { str: 'Keep this review' },
    id: `${ref.objectNumber}R`,
    titleObj: { str: 'Original reviewer' },
    creationDate: 'D:20200101000000Z',
    annotationFlags: 12,
  };
  return { bytes: await d.save(), seen };
}

async function annotationsOf(bytes: Uint8Array) {
  const saved = await PDFDocument.load(bytes);
  const arr = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  return arr ? arr.asArray().map((r) => saved.context.lookup(r, PDFDict)) : [];
}
const text = (d: PDFDict, key: string) => {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFHexString || v instanceof PDFString ? v.decodeText() : undefined;
};

describe('saving a PDF someone else annotated', () => {
  it('leaves an untouched annotation exactly as it was', async () => {
    const { bytes, seen } = await reviewed();
    const marks = importAnnotations(1, [seen], 1790690000000);
    const [a] = await annotationsOf(await withMarks(bytes, marks));
    expect(text(a!, 'T')).toBe('Original reviewer');
    expect(text(a!, 'CreationDate')).toBe('D:20200101000000Z');
    expect(text(a!, 'M')).toBe('D:20200102000000Z');
    expect(text(a!, 'NM')).toBe('their-id');
  });

  it('an edited one keeps its author, creation date and flags', async () => {
    const { bytes, seen } = await reviewed();
    const [mark] = importAnnotations(1, [seen], 1790690000000);
    const edited = { ...mark!, note: 'Replied', updated: 1790700000000 };
    const [a] = await annotationsOf(await withMarks(bytes, [edited]));
    expect(text(a!, 'Contents')).toBe('Replied');
    expect(text(a!, 'T')).toBe('Original reviewer');
    expect(text(a!, 'CreationDate')).toBe('D:20200101000000Z');
    expect((a!.lookup(PDFName.of('F')) as PDFNumber).asNumber()).toBe(12);
  });

  it('a deleted one is still removed', async () => {
    const { bytes } = await reviewed();
    expect(await annotationsOf(await withMarks(bytes, []))).toHaveLength(0);
  });

  it('a mark made in Aloud is still signed by Aloud', async () => {
    const { bytes } = await reviewed();
    const mine = { id: 'm', page: 1, kind: 'highlight' as const, color: '#ffd83a', boxes: [[40, 40, 90, 50]] as [number, number, number, number][], text: 't', note: '', created: 1, updated: 1 };
    const all = await annotationsOf(await withMarks(bytes, [mine]));
    expect(all.map((a) => text(a, 'T'))).toEqual(['Aloud']);
  });
});
