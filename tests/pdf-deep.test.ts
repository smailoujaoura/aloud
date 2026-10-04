/**
 * The third recheck's PDF findings, with real pdf-lib bytes: W02 (a shared drawing deleted with
 * a removed note), W04 (a cross-device restore keeping two copies of one annotation), and the
 * two-tab and save-race rules of W01/W05 at the level of the stored marks.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { importAnnotations, type Mark } from '@/pdf/annotations/model';
import { withMarks, withoutMarks } from '@/pdf/annotations/pdf-writer';
import { mergePdfMarks } from '@/shared/backup';
import { reconcileMarks, MarkSync } from '@/pdf/annotations/sync';
import { loadMarks } from '@/pdf/annotations/store';
import { resetStorage } from './stubs/wxt-storage';

async function contents(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).asArray().map((ref) => {
    const dict = doc.context.lookup(ref, PDFDict);
    return (dict.lookup(PDFName.of('Contents')) as PDFString | undefined)?.decodeText();
  });
}

describe('W02: a drawing shared with an annotation Aloud does not touch', () => {
  it('stays when the note that also used it is removed — for display and for the saved file', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage();
    const ap = d.context.register(d.context.stream('1 0 0 rg 0 0 20 20 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }));
    const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], AP: { N: ap } }));
    const stamp = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [40, 10, 60, 30], AP: { N: ap } }));
    p.node.set(PDFName.of('Annots'), d.context.obj([note, stamp]));
    const input = await d.save();
    for (const bytes of [await withoutMarks(input), await withMarks(input, [])]) {
      const out = await PDFDocument.load(bytes!);
      const kept = out.context.lookup(out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).get(0), PDFDict);
      expect(kept.lookup(PDFName.of('Subtype'))!.toString()).toBe('/Stamp');
      const drawing = kept.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'));
      expect(out.context.lookup(drawing)).toBeTruthy();
    }
  });

  it('a drawing only the removed note used is still removed', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage();
    const ap = d.context.register(d.context.stream('0 0 1 rg 0 0 20 20 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 20, 20] }));
    const note = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], AP: { N: ap } }));
    p.node.set(PDFName.of('Annots'), d.context.obj([note]));
    const out = await PDFDocument.load((await withMarks(await d.save(), []))!);
    expect(out.context.lookup(ap)).toBeUndefined();
  });
});

describe('W04: the same PDF annotation, imported on two devices', () => {
  async function reviewed() {
    const d = await PDFDocument.create();
    const p = d.addPage();
    const ref = d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30], Contents: PDFString.of('Original') }));
    p.node.set(PDFName.of('Annots'), d.context.obj([ref]));
    const seen = { annotationType: 1, rect: [10, 10, 30, 30], contentsObj: { str: 'Original' }, id: `${ref.objectNumber}R` };
    return { bytes: await d.save(), seen };
  }

  it('is one mark after a restore, with the edit kept', async () => {
    const { bytes, seen } = await reviewed();
    const local = importAnnotations(1, [seen], 1);
    const remote = importAnnotations(1, [seen], 2); // imported later on the other device, untouched
    local[0] = { ...local[0]!, note: 'Latest edit', updated: 3 };
    const merged = mergePdfMarks({ name: 'review.pdf', marks: local, updated: 3 }, { name: 'review.pdf', marks: remote, updated: 2 });
    expect(await contents(await withMarks(bytes, merged.marks as Mark[]))).toEqual(['Latest edit']);
  });

  it('an untouched copy imported later never replaces an edit made earlier elsewhere', async () => {
    const { seen } = await reviewed();
    const edited = { ...importAnnotations(1, [seen], 1)[0]!, note: 'Edited at 5', updated: 5 };
    const lateImport = importAnnotations(1, [seen], 99); // untouched, but imported at 99
    const merged = mergePdfMarks({ name: 'r', marks: [edited], updated: 5 }, { name: 'r', marks: lateImport, updated: 99 });
    expect((merged.marks as Mark[]).map((m) => m.note)).toEqual(['Edited at 5']);
  });

  it('marks stored with random ids before this fix are matched by their annotation', async () => {
    const { seen } = await reviewed();
    const old = { ...importAnnotations(1, [seen], 1)[0]!, id: 'random-1', note: 'Edited here', updated: 4 };
    const theirs = { ...importAnnotations(1, [seen], 1)[0]!, id: 'random-2' };
    const merged = mergePdfMarks({ name: 'r', marks: [old], updated: 4 }, { name: 'r', marks: [theirs], updated: 1 });
    expect(merged.marks).toHaveLength(1);
  });
});

const mark = (id: string, note: string, updated: number): Mark => ({
  id, page: 1, kind: 'note', color: '#ffd83a', boxes: [[1, 1, 2, 2]], text: '', note, created: 1, updated,
});

describe('W01: two tabs on the same PDF', () => {
  it('each tab’s edit to a different note survives the other’s save', async () => {
    resetStorage();
    const start = [mark('a', 'First', 1), mark('b', 'Second', 1)];
    const tabA = new MarkSync('doc', 'review.pdf', []);
    await tabA.persist(start);
    const tabB = new MarkSync('doc', 'review.pdf', start); // opened the same stored marks
    await tabA.persist([mark('a', 'Edited in A', 2), start[1]!]);
    await tabB.persist([start[0]!, mark('b', 'Edited in B', 3)]); // B never saw A's edit
    const stored = (await loadMarks('doc'))!.marks as Mark[];
    expect(stored.map((m) => m.note).sort()).toEqual(['Edited in A', 'Edited in B']);
  });

  it('the same note edited in both: the later edit wins', () => {
    const base = [mark('a', 'Original', 1)];
    expect(reconcileMarks([mark('a', 'Theirs', 5)], base, [mark('a', 'Mine', 3)]).map((m) => m.note)).toEqual(['Theirs']);
    expect(reconcileMarks([mark('a', 'Theirs', 5)], base, [mark('a', 'Mine', 7)]).map((m) => m.note)).toEqual(['Mine']);
  });

  it('a note deleted here that the other tab edited since is kept; otherwise deleted', () => {
    const base = [mark('a', 'Original', 1), mark('b', 'Other', 1)];
    expect(reconcileMarks([mark('a', 'Edited there', 4), base[1]!], base, [base[1]!]).map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(reconcileMarks(base, base, [base[1]!]).map((m) => m.id)).toEqual(['b']);
  });

  it('a note added in each tab: both kept', () => {
    const base = [mark('a', 'A', 1)];
    const theirs = [...base, mark('t', 'Theirs', 2)];
    expect(reconcileMarks(theirs, base, [...base, mark('m', 'Mine', 2)]).map((m) => m.id).sort()).toEqual(['a', 'm', 't']);
  });
});

describe('W05: an edit typed while the file was being written', () => {
  it('moves with the document to its new identity, instead of staying under the old one', async () => {
    resetStorage();
    const sync = new MarkSync('old-hash', 'review.pdf', []);
    await sync.persist([mark('a', 'Before save', 1)]);
    // The save wrote "Before save"; meanwhile the note was edited, and autosaved under the old hash.
    await sync.persist([mark('a', 'Typed while saving', 2)]);
    await sync.moveTo('new-hash', [mark('a', 'Typed while saving', 2)]);
    expect(((await loadMarks('new-hash'))!.marks as Mark[]).map((m) => m.note)).toEqual(['Typed while saving']);
  });
});

describe('a tab hearing its own write come back', () => {
  it('does not take it as another tab’s change (which would clear its undo history)', async () => {
    resetStorage();
    const { storage } = await import('wxt/utils/storage');
    const sync = new MarkSync('echo', 'r.pdf', []);
    let current: Mark[] = [mark('a', 'A', 1)];
    let adopted = 0;
    sync.watch(() => current, () => adopted++);
    await sync.persist(current);
    current = [mark('a', 'A edited', 2)];
    await sync.persist(current);
    expect(adopted).toBe(0);
    // A genuine change from elsewhere still arrives.
    await storage.setItem('local:pdfMarks:echo', { name: 'r.pdf', updated: 9, marks: [mark('a', 'A edited', 2), mark('b', 'From the other tab', 3)] });
    expect(adopted).toBe(1);
    sync.dispose();
  });
});
