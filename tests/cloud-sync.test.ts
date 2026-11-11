import { beforeEach, describe, expect, it } from 'vitest';
import { resetStorage, storage } from './stubs/wxt-storage';
import { reconcileById } from '@/shared/three-way';
import type { Note } from '@/shared/notes';
import type { Mark } from '@/pdf/annotations/model';
import {
  contentOf,
  emptyDoc,
  loadCloudStatus,
  parseDoc,
  runCloudSync,
  serializeDoc,
  type LocalData,
  type RemoteFile,
  type SyncDoc,
} from '@/sync/cloud-sync';

const note = (id: string, text: string, updatedAt = 1, createdAt = updatedAt): Note => ({
  id,
  text,
  comment: '',
  source: { key: 'https://example.org/a', title: 'A page', site: 'example.org', reopen: { kind: 'web', url: 'https://example.org/a' } },
  at: null,
  tags: [],
  createdAt,
  updatedAt,
});

const mark = (id: string, updated = 1): Mark =>
  ({ id, page: 1, kind: 'highlight', color: '#ffe066', boxes: [[0, 0, 10, 10]], text: `marked ${id}`, note: '', created: updated, updated }) as Mark;

const PDF = 'ab'.repeat(32);

/** The file in Dropbox. `meddle` runs once, between a round's read and its write: another device writing. */
class FakeFile implements RemoteFile {
  text: string | null = null;
  rev = 0;
  calls = 0;
  meddle: (() => void) | null = null;
  async revision() {
    this.calls++;
    return this.text === null ? null : `r${this.rev}`;
  }
  async download() {
    this.calls++;
    const got = this.text === null ? null : { text: this.text, rev: `r${this.rev}` };
    if (this.meddle) {
      const m = this.meddle;
      this.meddle = null;
      m();
    }
    return got;
  }
  async upload(text: string, rev: string | null) {
    this.calls++;
    const now = this.text === null ? null : `r${this.rev}`;
    if (rev !== now) return 'conflict' as const;
    this.text = text;
    this.rev++;
    return `r${this.rev}`;
  }
  get doc(): SyncDoc {
    return this.text === null ? emptyDoc() : parseDoc(this.text);
  }
}

/** A device: its notes and marks, and its own memory of the file. */
class Device implements LocalData {
  data: SyncDoc = emptyDoc();
  private book: unknown = null;
  /** Runs once while a round is under way: the reader keeping a note mid-sync. */
  during: (() => void) | null = null;

  async read() {
    return structuredClone(this.data);
  }
  async write(merged: SyncDoc, seen: SyncDoc) {
    if (this.during) {
      const d = this.during;
      this.during = null;
      d();
    }
    const now = this.data;
    const pdfMarks: SyncDoc['pdfMarks'] = {};
    for (const hash of new Set([...Object.keys(merged.pdfMarks), ...Object.keys(seen.pdfMarks), ...Object.keys(now.pdfMarks)])) {
      const marks = reconcileById(merged.pdfMarks[hash]?.marks ?? [], seen.pdfMarks[hash]?.marks ?? [], now.pdfMarks[hash]?.marks ?? [], (m) => m.updated);
      if (marks.length) pdfMarks[hash] = { name: now.pdfMarks[hash]?.name ?? merged.pdfMarks[hash]?.name ?? '', marks };
    }
    this.data = { ...emptyDoc(), notes: reconcileById(merged.notes, seen.notes, now.notes, (n) => n.updatedAt), pdfMarks };
  }
  async sync(file: RemoteFile, reason: 'here' | 'other' = 'other') {
    await storage.setItem('local:cloudSync', this.book ?? { rev: null, base: null, status: null });
    try {
      await runCloudSync(file, this, reason, 1000);
    } finally {
      this.book = await storage.getItem('local:cloudSync');
    }
  }
  texts(): string[] {
    return this.data.notes.map((n) => n.text).sort();
  }
}

describe('notes through one file, between two devices', () => {
  let file: FakeFile;
  let a: Device;
  let b: Device;
  beforeEach(() => {
    resetStorage();
    file = new FakeFile();
    a = new Device();
    b = new Device();
  });

  it('the first device puts its notes in the file; the second keeps its own and gets the first’s', async () => {
    a.data.notes = [note('1', 'From A')];
    b.data.notes = [note('2', 'From B')];
    await a.sync(file);
    expect(file.doc.notes.map((n) => n.text)).toEqual(['From A']);
    await b.sync(file);
    expect(b.texts()).toEqual(['From A', 'From B']);
    await a.sync(file);
    expect(a.texts()).toEqual(['From A', 'From B']);
  });

  it('a note deleted on one device is deleted on the other', async () => {
    a.data.notes = [note('1', 'Keep'), note('2', 'Delete me')];
    await a.sync(file);
    await b.sync(file);
    a.data.notes = a.data.notes.filter((n) => n.id !== '2');
    await a.sync(file, 'here');
    await b.sync(file);
    expect(b.texts()).toEqual(['Keep']);
  });

  it('deleted on one device, but edited on the other afterwards: kept', async () => {
    a.data.notes = [note('1', 'Draft', 1)];
    await a.sync(file);
    await b.sync(file);
    a.data.notes = [];
    b.data.notes = [{ ...note('1', 'Draft'), comment: 'written later', updatedAt: 5 }];
    await a.sync(file, 'here');
    await b.sync(file, 'here');
    await a.sync(file);
    expect(a.data.notes).toHaveLength(1);
    expect(a.data.notes[0]?.comment).toBe('written later');
  });

  it('edited on both: the later edit wins, on both', async () => {
    a.data.notes = [note('1', 'Text', 1)];
    await a.sync(file);
    await b.sync(file);
    a.data.notes = [{ ...note('1', 'Text'), comment: 'from A', updatedAt: 3 }];
    b.data.notes = [{ ...note('1', 'Text'), comment: 'from B', updatedAt: 4 }];
    await a.sync(file, 'here');
    await b.sync(file, 'here');
    await a.sync(file);
    expect(a.data.notes[0]?.comment).toBe('from B');
    expect(b.data.notes[0]?.comment).toBe('from B');
  });

  it('the file deleted from Dropbox deletes nothing here: it is written again from this device', async () => {
    a.data.notes = [note('1', 'One'), note('2', 'Two')];
    await a.sync(file);
    file.text = null;
    await a.sync(file);
    expect(a.texts()).toEqual(['One', 'Two']);
    expect(file.doc.notes).toHaveLength(2);
  });

  it('another device writing in the middle of a round is merged, not overwritten', async () => {
    a.data.notes = [note('1', 'From A')];
    await a.sync(file);
    b.data.notes = [note('2', 'From B')];
    file.meddle = () => {
      const doc = file.doc;
      doc.notes.push(note('3', 'Written meanwhile'));
      file.text = serializeDoc(doc);
      file.rev++;
    };
    await b.sync(file);
    expect(file.doc.notes.map((n) => n.text).sort()).toEqual(['From A', 'From B', 'Written meanwhile']);
    expect(b.texts()).toEqual(['From A', 'From B', 'Written meanwhile']);
  });

  it('a note kept while a round is under way stays', async () => {
    a.data.notes = [note('1', 'Before')];
    await a.sync(file);
    b.during = () => b.data.notes.push(note('9', 'Kept mid-sync'));
    await b.sync(file);
    expect(b.texts()).toEqual(['Before', 'Kept mid-sync']);
    await b.sync(file, 'here');
    expect(file.doc.notes.map((n) => n.text).sort()).toEqual(['Before', 'Kept mid-sync']);
  });

  it('a change made here with nothing new asks Dropbox nothing', async () => {
    a.data.notes = [note('1', 'One')];
    await a.sync(file);
    const calls = file.calls;
    await a.sync(file, 'here');
    expect(file.calls).toBe(calls);
    // A check from the timer with nothing new: one question, no download, no upload.
    await a.sync(file, 'other');
    expect(file.calls).toBe(calls + 1);
  });

  it('PDF marks: added on one device, deleted on another, as notes are', async () => {
    a.data.pdfMarks = { [PDF]: { name: 'paper.pdf', marks: [mark('m1'), mark('m2')] } };
    await a.sync(file);
    b.data.pdfMarks = { [PDF]: { name: 'paper (1).pdf', marks: [] } };
    await b.sync(file);
    expect(b.data.pdfMarks[PDF]?.marks.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    // The name B saved it under stays B's; the file keeps the first name it had.
    expect(b.data.pdfMarks[PDF]?.name).toBe('paper (1).pdf');
    b.data.pdfMarks[PDF]!.marks = b.data.pdfMarks[PDF]!.marks.filter((m) => m.id !== 'm2');
    await b.sync(file, 'here');
    await a.sync(file);
    expect(a.data.pdfMarks[PDF]?.marks.map((m) => m.id)).toEqual(['m1']);
    expect(file.doc.pdfMarks[PDF]?.name).toBe('paper.pdf');
  });

  it('says when it last synced, and how much', async () => {
    a.data.notes = [note('1', 'One'), note('2', 'Two')];
    a.data.pdfMarks = { [PDF]: { name: 'p.pdf', marks: [mark('m1')] } };
    await a.sync(file);
    expect(await loadCloudStatus()).toEqual({ at: 1000, notes: 2, pdfs: 1 });
  });
});

describe('the file', () => {
  it('one that is not Aloud’s is refused, not read as empty', () => {
    expect(() => parseDoc('{"hello": 1}')).toThrow(/not one Aloud can read/);
    expect(() => parseDoc('not json')).toThrow(/not one Aloud can read/);
  });

  it('broken notes and marks in it are left out', () => {
    const doc = parseDoc(
      JSON.stringify({
        format: 'aloud-sync',
        version: 1,
        notes: [note('1', 'Good'), { id: '2' }, null],
        pdfMarks: { [PDF]: { name: 'p.pdf', marks: [mark('m1'), { id: 'bad' }] }, 'not-a-hash': { marks: [mark('x')] } },
      }),
    );
    expect(doc.notes.map((n) => n.id)).toEqual(['1']);
    expect(Object.keys(doc.pdfMarks)).toEqual([PDF]);
    expect(doc.pdfMarks[PDF]?.marks.map((m) => m.id)).toEqual(['m1']);
  });

  it('order and file names aside, the same notes are the same content', () => {
    const one = { ...emptyDoc(), notes: [note('1', 'A'), note('2', 'B')], pdfMarks: { [PDF]: { name: 'x.pdf', marks: [mark('m1')] } } };
    const two = { ...emptyDoc(), notes: [note('2', 'B'), note('1', 'A')], pdfMarks: { [PDF]: { name: 'y.pdf', marks: [mark('m1')] } } };
    expect(contentOf(one)).toBe(contentOf(two));
  });
});
