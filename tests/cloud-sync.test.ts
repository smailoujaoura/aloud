import { beforeEach, describe, expect, it } from 'vitest';
import { resetStorage, storage } from './stubs/wxt-storage';
import { reconcileById, reconcileMaps } from '@/shared/three-way';
import { MAX_SAVED_POSITIONS } from '@/shared/position-match';
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
    this.data = {
      ...emptyDoc(),
      notes: reconcileById(merged.notes, seen.notes, now.notes, (n) => n.updatedAt),
      pdfMarks,
      positions: reconcileMaps(merged.positions, seen.positions, now.positions, (p) => p.savedAt),
      history: reconcileMaps(merged.history, seen.history, now.history, (h) => h.lastReadAt),
      // As dropbox-sync.ts stores them: the merged value, unless changed here meanwhile.
      settings: Object.fromEntries(
        Object.entries(merged.settings).map(([k, e]) => [k, seen.settings[k] && JSON.stringify(now.settings[k]?.v) !== JSON.stringify(seen.settings[k]!.v) ? now.settings[k]! : { v: e.v, at: 0 }]),
      ),
    };
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
    a.data.positions = { 'https://example.org/a': { index: 3, total: 9, excerpt: 'three', savedAt: 5 } };
    await a.sync(file, 'here');
    expect(await loadCloudStatus()).toEqual({ at: 1000, notes: 2, pdfs: 1, places: 1 });
  });
});

describe('where you stopped, between two devices', () => {
  let file: FakeFile;
  let a: Device;
  let b: Device;
  const at = (index: number, savedAt: number) => ({ index, total: 40, excerpt: `sentence ${index}`, savedAt });
  beforeEach(() => {
    resetStorage();
    file = new FakeFile();
    a = new Device();
    b = new Device();
  });

  it('a place kept on one device is where the other picks up; the later place wins', async () => {
    a.data.positions = { 'https://example.org/long-read': at(12, 100) };
    await a.sync(file);
    await b.sync(file);
    expect(b.data.positions['https://example.org/long-read']).toEqual(at(12, 100));
    b.data.positions = { 'https://example.org/long-read': at(30, 200) };
    await b.sync(file, 'here');
    await a.sync(file);
    expect(a.data.positions['https://example.org/long-read']?.index).toBe(30);
  });

  it('Forget reading positions on one device forgets them on the other', async () => {
    a.data.positions = { x: at(1, 10), y: at(2, 20) };
    await a.sync(file);
    await b.sync(file);
    a.data.positions = {};
    await a.sync(file, 'here');
    await b.sync(file);
    expect(b.data.positions).toEqual({});
  });

  it('a file from before positions were synced reads as having none', () => {
    const doc = parseDoc(JSON.stringify({ format: 'aloud-sync', version: 1, notes: [], pdfMarks: {} }));
    expect(doc.positions).toEqual({});
  });

  it('keeps the most recent, as many as a device does', async () => {
    a.data.positions = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`a${i}`, at(i, 1000 + i)]));
    b.data.positions = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`b${i}`, at(i, 2000 + i)]));
    await a.sync(file);
    await b.sync(file);
    expect(Object.keys(file.doc.positions)).toHaveLength(MAX_SAVED_POSITIONS);
    expect(file.doc.positions.b299).toBeDefined();
    expect(file.doc.positions.a0).toBeUndefined();
  });
});

describe('what you listened to (Continue and History), between two devices', () => {
  let file: FakeFile;
  let a: Device;
  let b: Device;
  const entry = (url: string, index: number, lastReadAt: number) => ({
    source: { key: url, title: 'A long read', site: 'example.org', reopen: { kind: 'web' as const, url } },
    index,
    total: 40,
    charsRead: index * 100,
    charsTotal: 4000,
    listenedSeconds: index * 6,
    secondsPerChar: 0.06,
    finished: false,
    firstReadAt: 1,
    lastReadAt,
  });
  beforeEach(() => {
    resetStorage();
    file = new FakeFile();
    a = new Device();
    b = new Device();
  });

  it('what one device was listening to is in the other’s Continue list, as far as it got', async () => {
    const url = 'https://example.org/long-read';
    a.data.history = { [url]: entry(url, 12, 100) };
    await a.sync(file);
    await b.sync(file);
    expect(b.data.history[url]?.index).toBe(12);
    b.data.history = { [url]: entry(url, 30, 200) };
    await b.sync(file, 'here');
    await a.sync(file);
    expect(a.data.history[url]?.index).toBe(30);
  });

  it('removed from History on one device, removed on the other', async () => {
    const url = 'https://example.org/x';
    a.data.history = { [url]: entry(url, 5, 10) };
    await a.sync(file);
    await b.sync(file);
    a.data.history = {};
    await a.sync(file, 'here');
    await b.sync(file);
    expect(b.data.history).toEqual({});
  });

  it('broken entries in the file are left out, and a file without history reads as none', () => {
    const url = 'https://example.org/y';
    const doc = parseDoc(JSON.stringify({ format: 'aloud-sync', version: 1, notes: [], pdfMarks: {}, history: { [url]: entry(url, 1, 1), bad: { index: 'x' } } }));
    expect(Object.keys(doc.history)).toEqual([url]);
    expect(parseDoc(JSON.stringify({ format: 'aloud-sync', version: 1, notes: [], pdfMarks: {} })).history).toEqual({});
  });
});

describe('settings, between two devices', () => {
  let file: FakeFile;
  let a: Device;
  let b: Device;
  const speedOf = (d: Device) => d.data.settings.speed?.v;
  beforeEach(() => {
    resetStorage();
    file = new FakeFile();
    a = new Device();
    b = new Device();
  });

  it('a device that connects takes the others’ settings; a change on either then travels', async () => {
    a.data.settings = { speed: { v: 1.4, at: 0 }, theme: { v: 'dark', at: 0 } };
    await a.sync(file);
    b.data.settings = { speed: { v: 1, at: 0 }, theme: { v: 'light', at: 0 } };
    await b.sync(file);
    expect(speedOf(b)).toBe(1.4);
    expect(b.data.settings.theme?.v).toBe('dark');
    b.data.settings.speed = { v: 1.8, at: 0 };
    await b.sync(file, 'here');
    await a.sync(file);
    expect(speedOf(a)).toBe(1.8);
  });

  it('a file from before settings were in it reads as having none, and gets this device’s', async () => {
    expect(parseDoc(JSON.stringify({ format: 'aloud-sync', version: 1, notes: [], pdfMarks: {} })).settings).toEqual({});
    file.text = JSON.stringify({ format: 'aloud-sync', version: 1, notes: [], pdfMarks: {} });
    file.rev = 1;
    a.data.settings = { speed: { v: 1.3, at: 0 } };
    await a.sync(file);
    expect(file.doc.settings.speed?.v).toBe(1.3);
  });

  it('rules added on both devices between syncs: both kept', async () => {
    a.data.settings = { pronunciations: { v: [{ from: 'GIF', to: 'jif' }], at: 0 } };
    await a.sync(file);
    await b.sync(file);
    a.data.settings = { pronunciations: { v: [{ from: 'GIF', to: 'jif' }, { from: 'SQL', to: 'sequel' }], at: 0 } };
    b.data.settings = { pronunciations: { v: [{ from: 'GIF', to: 'jif' }, { from: 'nginx', to: 'engine x' }], at: 0 } };
    await a.sync(file, 'here');
    await b.sync(file, 'here');
    await a.sync(file);
    const froms = (d: Device) => (d.data.settings.pronunciations?.v as Array<{ from: string }>).map((r) => r.from).sort();
    expect(froms(a)).toEqual(['GIF', 'SQL', 'nginx']);
    expect(froms(b)).toEqual(['GIF', 'SQL', 'nginx']);
  });

  it('different switches of one group changed on two devices: both kept', async () => {
    const skip = (code: boolean, tables: boolean) => ({ v: { code, tables, captions: false, references: false }, at: 0 });
    a.data.settings = { skip: skip(false, false) };
    await a.sync(file);
    await b.sync(file);
    a.data.settings = { skip: skip(true, false) };
    b.data.settings = { skip: skip(false, true) };
    await a.sync(file, 'here');
    await b.sync(file, 'here');
    await a.sync(file);
    expect(a.data.settings.skip?.v).toMatchObject({ code: true, tables: true });
    expect(b.data.settings.skip?.v).toMatchObject({ code: true, tables: true });
  });

  it('only the settings that travel are read from the file', () => {
    const doc = parseDoc(JSON.stringify({ format: 'aloud-sync', version: 1, notes: [], pdfMarks: {}, settings: { speed: { v: 1.2, at: 3 }, engine: { v: 'kokoro', at: 3 }, theme: 'dark' }, settingsVersion: 10 }));
    expect(Object.keys(doc.settings)).toEqual(['speed']);
  });
});

describe('a file replaced, restored or written by a newer Aloud', () => {
  let file: FakeFile;
  let a: Device;
  let b: Device;
  beforeEach(() => {
    resetStorage();
    file = new FakeFile();
    a = new Device();
    b = new Device();
  });

  it('deleted, and written anew by a device that was offline: nothing it lacked is deleted elsewhere', async () => {
    a.data.notes = [note('x', 'Old note')];
    await a.sync(file);
    await b.sync(file);
    b.data.notes = [...b.data.notes, note('n', 'Added on B')];
    await b.sync(file, 'here');
    file.text = null; // the reader deleted aloud.json
    await a.sync(file); // A never saw "Added on B"
    await b.sync(file);
    expect(b.texts()).toEqual(['Added on B', 'Old note']);
    expect(file.doc.notes.map((n) => n.text).sort()).toEqual(['Added on B', 'Old note']);
    await a.sync(file);
    expect(a.texts()).toEqual(['Added on B', 'Old note']);
  });

  it('restored from Dropbox’s version history: what was added since is kept, not deleted', async () => {
    a.data.notes = [note('x', 'Old note')];
    await a.sync(file);
    const before = { text: file.text, rev: file.rev };
    a.data.notes = [...a.data.notes, note('n', 'Added later')];
    await a.sync(file, 'here');
    file.text = before.text; // an earlier version put back
    file.rev += 1;
    await a.sync(file);
    expect(a.texts()).toEqual(['Added later', 'Old note']);
    expect(file.doc.notes).toHaveLength(2);
  });

  it('restored, then written on: a device that remembered more is still not fooled by the counts', async () => {
    const c = new Device();
    a.data.notes = [note('base', 'Base')];
    await a.sync(file);
    await c.sync(file);
    const early = { text: file.text, rev: file.rev };
    c.data.notes = [...c.data.notes, note('x', 'Kept on C')];
    await c.sync(file, 'here');
    for (let i = 0; i < 3; i++) {
      c.data.notes = [...c.data.notes, note(`c${i}`, `More ${i}`)];
      await c.sync(file, 'here');
    }
    // The early version is put back, then A (which never saw C's notes) writes several times.
    file.text = early.text;
    file.rev += 1;
    for (let i = 0; i < 6; i++) {
      a.data.notes = [...a.data.notes, note(`a${i}`, `A ${i}`)];
      await a.sync(file, 'here');
    }
    await c.sync(file);
    expect(c.texts()).toContain('Kept on C');
    expect(file.doc.notes.map((n) => n.text)).toContain('Kept on C');
  });

  it('written by a newer Aloud: refused, and left exactly as it is', async () => {
    file.text = JSON.stringify({ format: 'aloud-sync', version: 2, notes: [note('1', 'From the future')], pdfMarks: {}, queue: [{ id: 'q' }] });
    file.rev = 3;
    const untouched = file.text;
    a.data.notes = [note('2', 'Mine')];
    await expect(a.sync(file)).rejects.toThrow(/newer Aloud/);
    expect(file.text).toBe(untouched);
    expect(a.texts()).toEqual(['Mine']);
  });

  it('each upload adds one write to the file’s ancestry', async () => {
    a.data.notes = [note('1', 'One')];
    await a.sync(file);
    const first = file.doc;
    a.data.notes = [...a.data.notes, note('2', 'Two')];
    await a.sync(file, 'here');
    expect(first.writes).toHaveLength(1);
    expect(file.doc.writes).toEqual([...first.writes, file.doc.writes[1]]);
  });
});

describe('a device that synced with an earlier build', () => {
  it('remembering the file without history: other devices’ history is not deleted', async () => {
    resetStorage();
    const file = new FakeFile();
    const a = new Device();
    const b = new Device();
    const url = 'https://example.org/read-on-b';
    const entry = { source: { key: url, title: 'B read it', site: 'example.org', reopen: { kind: 'web' as const, url } }, index: 3, total: 9, charsRead: 30, charsTotal: 90, listenedSeconds: 60, secondsPerChar: null, finished: false, firstReadAt: 1, lastReadAt: 5 };
    b.data.history = { [url]: entry };
    await b.sync(file);
    await a.sync(file);
    // A's memory as a build from before history was in the file left it: without history.
    const remembered = JSON.parse(JSON.stringify((a as unknown as { book: { base: Record<string, unknown> } }).book));
    delete remembered.base.history;
    delete remembered.base.settings;
    delete remembered.base.writes;
    (a as unknown as { book: unknown }).book = remembered;
    a.data.history = {};
    await a.sync(file, 'here');
    await b.sync(file);
    expect(b.data.history[url]).toBeDefined();
  });

  it('its remembered file, without positions, history or settings, is read as having none', async () => {
    resetStorage();
    const file = new FakeFile();
    const a = new Device();
    a.data.notes = [note('1', 'Kept before the update')];
    await a.sync(file);
    // What a build from before positions, history and settings left behind.
    const old = { format: 'aloud-sync', version: 1, notes: [note('1', 'Kept before the update')], pdfMarks: {} };
    file.text = JSON.stringify(old);
    (a as unknown as { book: unknown }).book = { rev: `r${file.rev}`, base: old, status: null };
    a.data.settings = { speed: { v: 1.3, at: 0 } };
    a.data.history = {};
    await a.sync(file, 'here');
    expect(await loadCloudStatus()).not.toHaveProperty('error');
    expect(file.doc.settings.speed?.v).toBe(1.3);
    expect(file.doc.notes.map((n) => n.text)).toEqual(['Kept before the update']);
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

describe('reconnecting', () => {
  it('the same account carries on from what this device remembers; another starts afresh', async () => {
    const { prepareCloudSync } = await import('@/sync/cloud-sync');
    resetStorage();
    await storage.setItem('local:cloudSync', { rev: 'r9', base: { ...emptyDoc(), notes: [note('1', 'Kept')] }, status: { at: 1, error: 'x' }, accountId: 'dbid:A' });
    await prepareCloudSync('dbid:A');
    const same = (await storage.getItem('local:cloudSync')) as { rev: string; base: SyncDoc; status: unknown };
    expect(same.rev).toBe('r9');
    expect(same.base.notes).toHaveLength(1);
    expect(same.status).toBeNull();
    await prepareCloudSync('dbid:B');
    expect(await storage.getItem('local:cloudSync')).toEqual({ rev: null, base: null, status: null, accountId: 'dbid:B' });
  });
});

describe('three-way rules', () => {
  it('deleted here, but edited there by a device whose clock runs slow: kept', () => {
    const before = note('1', 'Text', 100);
    const editedSlowClock = { ...note('1', 'Text'), comment: 'added later, clock behind', updatedAt: 90 };
    expect(reconcileById([editedSlowClock], [before], [], (n) => n.updatedAt)).toEqual([editedSlowClock]);
    expect(reconcileById([before], [before], [], (n) => n.updatedAt)).toEqual([]);
  });
});
