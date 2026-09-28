/**
 * The audit's A04: saving a PDF deleted annotations Aloud never imported.
 *
 * Real pdf-lib bytes, the real importer, and the real writer.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFArray } from 'pdf-lib';
import { importAnnotations, type PdfJsAnnotation } from '@/pdf/annotations/model';
import { withMarks } from '@/pdf/annotations/pdf-writer';

/** A one-page PDF with one Text annotation, `flags` as its /F value. */
async function pdfWithNote(flags: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const note = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: doc.context.obj([10, 10, 30, 30]),
    Contents: PDFString.of('someone else’s comment'),
    F: PDFNumber.of(flags),
  });
  page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(note)]));
  return doc.save();
}

async function annotationCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPages()[0]!.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  return annots ? annots.asArray().length : 0;
}

const NO_VIEW = 32;

describe('saving a PDF', () => {
  it('keeps an annotation the importer skipped', async () => {
    const bytes = await pdfWithNote(NO_VIEW);
    // The importer skips it — so the reader never saw it and cannot have meant to delete it.
    const hidden: PdfJsAnnotation = { annotationType: 1, rect: [10, 10, 30, 30], noView: true };
    expect(importAnnotations(1, [hidden])).toHaveLength(0);

    const saved = await withMarks(bytes, []);
    expect(await annotationCount(saved)).toBe(1);
  });

  it('still replaces the marks it did import', async () => {
    const bytes = await pdfWithNote(0);
    const visible: PdfJsAnnotation = { annotationType: 1, rect: [10, 10, 30, 30] };
    expect(importAnnotations(1, [visible])).toHaveLength(1);

    const saved = await withMarks(bytes, [
      { id: 'm1', page: 1, kind: 'highlight', color: '#ffd83a', boxes: [[10, 10, 40, 24]], text: 'hi', note: '', created: 1, updated: 1 },
    ]);
    // The original note is gone and exactly one mark is written in its place.
    expect(await annotationCount(saved)).toBe(1);
  });
});
