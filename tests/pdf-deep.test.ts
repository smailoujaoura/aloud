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

describe('X02: the tab closes before its last edit is written', async () => {
  const { persistChanges } = await import('@/pdf/annotations/sync');

  it('hands over only when something is unwritten', async () => {
    resetStorage();
    const sync = new MarkSync('close', 'r.pdf', []);
    await sync.persist([mark('a', 'Saved', 1)]);
    expect(sync.handoff([mark('a', 'Saved', 1)], false)).toBeNull();
    const h = sync.handoff([mark('a', 'Typed just before close', 2)], true)!;
    expect(h).toMatchObject({ type: 'pdf-marks-handoff', hash: 'close', name: 'r.pdf' });
    sync.dispose();
  });

  it('the background finishes it by the same rules, keeping another tab’s change', async () => {
    resetStorage();
    const sync = new MarkSync('close2', 'r.pdf', []);
    await sync.persist([mark('a', 'A', 1), mark('b', 'B', 1)]);
    const h = sync.handoff([mark('a', 'Typed just before close', 2), mark('b', 'B', 1)], true)!;
    // Meanwhile another tab changed b.
    await persistChanges('close2', 'r.pdf', [mark('a', 'A', 1), mark('b', 'B', 1)], [mark('a', 'A', 1), mark('b', 'B from the other tab', 3)]);
    await persistChanges(h.hash, h.name, h.baseline, h.current);
    const stored = ((await loadMarks('close2'))!.marks as Mark[]).map((m) => m.note);
    expect(stored).toEqual(['Typed just before close', 'B from the other tab']);
    sync.dispose();
  });
});

describe('the fifth recheck', async () => {
  const { withStorageLock } = await import('@/shared/storage-lock');
  const { unsettledSyncs } = await import('@/pdf/annotations/sync');
  const { normalizeStoredMarks } = await import('@/shared/record-shapes');
  /** Hold a document's lock, as another page writing it would. */
  const holdLock = (hash: string) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const done = withStorageLock(`pdfMarks:${hash}`, () => held);
    return { release, done };
  };

  it('Y02: an edit and its Undo, both queued behind a busy lock — the Undo is what stays stored', async () => {
    resetStorage();
    const sync = new MarkSync('undo', 'r.pdf', []);
    let shown: Mark[] = [mark('a', 'Original', 1)];
    await sync.persist(() => shown);
    const lock = holdLock('undo');
    shown = [mark('a', 'Edited', 2)];
    const first = sync.persist(() => shown); // autosave of the edit, waiting
    shown = [mark('a', 'Original', 1)]; // Undo
    const second = sync.persist(() => shown); // autosave of the Undo, waiting
    lock.release();
    await Promise.all([lock.done, first, second]);
    expect(((await loadMarks('undo'))!.marks as Mark[]).map((m) => m.note)).toEqual(['Original']);
  });

  it('a change from another tab arriving while this tab’s write waits is not taken as a deletion', async () => {
    resetStorage();
    const { storage } = await import('wxt/utils/storage');
    const sync = new MarkSync('race', 'r.pdf', []);
    let shown: Mark[] = [mark('a', 'A', 1)];
    sync.watch(() => shown, (next) => (shown = next));
    await sync.persist(() => shown);
    const lock = holdLock('race');
    shown = [mark('a', 'A edited here', 2)];
    const write = sync.persist(() => shown);
    // The other tab's write lands (its own lock, already released), and this editor takes it in.
    await storage.setItem('local:pdfMarks:race', { name: 'r.pdf', updated: 3, marks: [mark('a', 'A', 1), mark('t', 'From the other tab', 3)] });
    lock.release();
    await Promise.all([lock.done, write]);
    const stored = ((await loadMarks('race'))!.marks as Mark[]).map((m) => m.note).sort();
    expect(stored).toEqual(['A edited here', 'From the other tab']);
    sync.dispose();
  });

  it('Y01: a document with a write still waiting can be handed off after it is no longer on screen', async () => {
    resetStorage();
    const sync = new MarkSync('left', 'r.pdf', []);
    await sync.persist([mark('a', 'Original A', 1)]);
    const lock = holdLock('left');
    let marks: Mark[] = [mark('a', 'Quick edit', 2)];
    const write = sync.persist(() => marks);
    sync.dispose(); // switched to another PDF
    expect(unsettledSyncs.has(sync)).toBe(true);
    expect(sync.handoff()?.current.map((m) => m.note)).toEqual(['Quick edit']);
    lock.release();
    await Promise.all([lock.done, write]);
    expect(unsettledSyncs.has(sync)).toBe(false);
    expect(((await loadMarks('left'))!.marks as Mark[]).map((m) => m.note)).toEqual(['Quick edit']);
  });

  it('Y04: a stored mark without geometry is refused', () => {
    const r = normalizeStoredMarks({ name: 'r', updated: 1, marks: [{ ...mark('bad', 'x', 1), boxes: [] }, mark('ok', 'y', 1)] })!;
    expect((r.marks as Mark[]).map((m) => m.id)).toEqual(['ok']);
  });
});

describe('the sixth recheck', async () => {
  const { vi } = await import('vitest');
  const { storage } = await import('wxt/utils/storage');
  const { persistChanges } = await import('@/pdf/annotations/sync');
  const { withStorageLock } = await import('@/shared/storage-lock');
  const { saveMarks } = await import('@/pdf/annotations/store');

  it('Z01: an edit whose write did not finish is still in the handoff', async () => {
    resetStorage();
    const sync = new MarkSync('interrupted', 'a.pdf', []);
    await sync.persist([mark('a', 'Original', 1)]);
    let entered!: () => void;
    let fail!: (err: Error) => void;
    const started = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((_, r) => (fail = r));
    const spy = vi.spyOn(storage, 'setItem').mockImplementationOnce(async () => {
      entered();
      await held;
    });
    const write = sync.persist([mark('a', 'Edited', 2)]).catch(() => undefined);
    await started;
    const handoff = sync.handoff()!; // the tab closes here, mid-write
    fail(new Error('the page went away'));
    await write;
    spy.mockRestore();
    await persistChanges(handoff.hash, handoff.name, handoff.baseline, handoff.current);
    expect(((await loadMarks('interrupted'))!.marks as Mark[]).map((m) => m.note)).toEqual(['Edited']);
  });

  it('Z02: a note restored meanwhile survives two flushes of an editor switched away from', async () => {
    resetStorage();
    const sync = new MarkSync('departed', 'a.pdf', []);
    const original = mark('a', 'Original', 1);
    await sync.persist([original]);
    let release!: () => void;
    const lock = withStorageLock('pdfMarks:departed', () => new Promise<void>((r) => (release = r)));
    const shown = [mark('a', 'Local edit', 2)];
    const first = sync.persist(() => shown); // its autosave, waiting
    const final = sync.persist(() => shown); // the switch's final flush, waiting
    sync.dispose();
    await saveMarks('departed', 'a.pdf', [original, mark('remote', 'Restored note', 3)]); // the restore
    release();
    await Promise.all([lock, first, final]);
    expect(((await loadMarks('departed'))!.marks as Mark[]).map((m) => m.note).sort()).toEqual(['Local edit', 'Restored note']);
  });
});
