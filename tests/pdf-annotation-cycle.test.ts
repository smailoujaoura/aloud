/**
 * The second recheck's V02 and V05, with real pdf-lib bytes.
 *
 * V02: edit a reviewer's comment, save, reopen (marks restored for the new file), change the text
 * back, save again — and the annotation was gone. V05: an origin with a non-text author survived
 * validation and made every export of that PDF throw.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { importAnnotations, type Mark } from '@/pdf/annotations/model';
import { withMarks, writeMarks } from '@/pdf/annotations/pdf-writer';
import { normalizeStoredMarks } from '@/shared/record-shapes';

async function reviewed() {
  const d = await PDFDocument.create();
  const p = d.addPage();
  const ref = d.context.register(
    d.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [10, 10, 30, 30],
      Contents: PDFString.of('Original comment'),
      T: PDFString.of('Reviewer'),
      CreationDate: PDFString.of('D:20200101000000Z'),
    }),
  );
  p.node.set(PDFName.of('Annots'), d.context.obj([ref]));
  const marks = importAnnotations(1, [
    {
      annotationType: 1,
      rect: [10, 10, 30, 30],
      contentsObj: { str: 'Original comment' },
      id: `${ref.objectNumber}R`,
      titleObj: { str: 'Reviewer' },
      creationDate: 'D:20200101000000Z',
    },
  ]);
  return { bytes: await d.save(), marks };
}

async function annotations(bytes: Uint8Array) {
  const d = await PDFDocument.load(bytes);
  return d.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.asArray().map((r) => d.context.lookup(r, PDFDict)) ?? [];
}
const text = (a: PDFDict, key: string) => (a.lookup(PDFName.of(key)) as PDFString | PDFHexString | undefined)?.decodeText();
/** What startEditor keeps for the new file, and gives back on reopening it. */
const storedAndRestored = (marks: readonly Mark[]) => normalizeStoredMarks({ name: 'review.pdf', updated: 1, marks })!.marks as Mark[];

describe('edit, save, reopen, change back, save', () => {
  it('keeps the annotation, with the reviewer as its author', async () => {
    const { bytes, marks } = await reviewed();
    const first = await writeMarks(bytes, [{ ...marks[0]!, note: 'Edited comment', updated: 2 }]);
    expect(await annotations(first.bytes)).toHaveLength(1);

    const [reopened] = storedAndRestored(first.marks);
    const second = await withMarks(first.bytes, [{ ...reopened!, note: 'Original comment', updated: 3 }]);
    const after = await annotations(second);
    expect(after).toHaveLength(1);
    expect(text(after[0]!, 'Contents')).toBe('Original comment');
    expect(text(after[0]!, 'T')).toBe('Reviewer');
  });

  it('keeps it even when the remembered marks are stale (saved before this fix)', async () => {
    const { bytes, marks } = await reviewed();
    const edited = { ...marks[0]!, note: 'Edited comment', updated: 2 };
    const saved = await withMarks(bytes, [edited]);
    // The old flow remembered the mark with its *original* reference, for the new file.
    const [stale] = storedAndRestored([edited]);
    const output = await withMarks(saved, [{ ...stale!, note: 'Original comment', updated: 3 }]);
    expect(await annotations(output)).toHaveLength(1);
  });

  it('an untouched mark reopened from the written file is still left exactly as it is', async () => {
    const { bytes, marks } = await reviewed();
    const first = await writeMarks(bytes, marks);
    const [reopened] = storedAndRestored(first.marks);
    const after = await annotations(await withMarks(first.bytes, [reopened!]));
    expect(after).toHaveLength(1);
    expect(text(after[0]!, 'CreationDate')).toBe('D:20200101000000Z');
  });
});

describe('a damaged origin', () => {
  it('is repaired field by field: the mark is kept, and the PDF still saves', async () => {
    const { bytes, marks } = await reviewed();
    const poisoned = { ...marks[0]!, note: 'Edited', origin: { author: ['Reviewer'], created: 7, flags: 'x', ref: {}, fingerprint: null } };
    const kept = storedAndRestored([poisoned as never]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.origin).toEqual({ ref: null, author: '', created: null, flags: null, fingerprint: '' });
    const out = await annotations(await withMarks(bytes, kept));
    expect(out).toHaveLength(1);
    expect(text(out[0]!, 'Contents')).toBe('Edited');
  });
});
