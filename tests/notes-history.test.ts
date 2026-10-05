import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import {
  filterNotes,
  groupBySource,
  noteFacets,
  notesForPage,
  notesToFile,
  parseNotesFile,
  notesToMarkdown,
  parseTags,
  searchNotes,
  withNoteAdded,
  withNoteRemoved,
  withNoteUpdated,
  type Note,
} from '@/shared/notes';
import {
  MAX_HISTORY,
  continueList,
  formatListeningTime,
  progressOf,
  remainingSeconds,
  withListening,
  type History,
  type ListeningUpdate,
} from '@/shared/reading-history';
import type { DocSource } from '@/shared/doc-source';

const web = (key: string, title = key): DocSource => ({ key, title, site: 'example.com', reopen: { kind: 'web', url: key } });

function note(over: Partial<Note> & { id: string }): Note {
  return { text: 'A passage.', comment: '', source: web('https://example.com/a', 'Article A'), at: null, createdAt: 1000, updatedAt: 1000, ...over };
}

describe('notes', () => {
  it('keeps one note when the same sentence is saved twice in a row, newest first otherwise', () => {
    let notes: Note[] = [];
    notes = withNoteAdded(notes, note({ id: '1', createdAt: 1000 })).notes;
    const again = withNoteAdded(notes, note({ id: '2', createdAt: 5000 }));
    expect(again.duplicate).toBe(true);
    expect(again.added.id).toBe('1');
    const later = withNoteAdded(notes, note({ id: '3', createdAt: 10 * 60_000 }));
    expect(later.duplicate).toBe(false);
    expect(later.notes.map((n) => n.id)).toEqual(['3', '1']);
  });

  it('edits and removes', () => {
    const notes = [note({ id: '1' }), note({ id: '2' })];
    expect(withNoteUpdated(notes, '2', { comment: 'why' }, 9)[1]).toMatchObject({ comment: 'why', updatedAt: 9 });
    expect(withNoteRemoved(notes, '1').map((n) => n.id)).toEqual(['2']);
  });

  it('searches passage, comment, title and site with every word', () => {
    const notes = [
      note({ id: '1', text: 'Mitochondria make energy.', comment: 'exam' }),
      note({ id: '2', text: 'Cells divide.', source: web('https://b.org/x', 'Biology notes') }),
    ];
    expect(searchNotes(notes, 'energy exam').map((n) => n.id)).toEqual(['1']);
    expect(searchNotes(notes, 'BIOLOGY').map((n) => n.id)).toEqual(['2']);
    expect(searchNotes(notes, '  ')).toHaveLength(2);
  });

  it('groups by document in reading order and exports Markdown', () => {
    const a = web('https://example.com/a', 'Article A');
    const b = web('https://example.com/b', 'Article B');
    const notes = [
      note({ id: '1', source: a, text: 'Later sentence.', at: { index: 9, total: 20, excerpt: '' }, createdAt: 3000 }),
      note({ id: '2', source: b, text: 'Other doc.', createdAt: 2000, comment: 'Follow up' }),
      note({ id: '3', source: a, text: 'Earlier sentence.', at: { index: 2, total: 20, excerpt: '' }, createdAt: 4000 }),
    ];
    const groups = groupBySource(notes);
    expect(groups.map((g) => g.source.title)).toEqual(['Article A', 'Article B']);
    expect(groups[0]!.notes.map((n) => n.id)).toEqual(['3', '1']);
    expect(notesToMarkdown(notes)).toBe(
      '## Article A\n<https://example.com/a>\n\n> Earlier sentence.\n\n> Later sentence.\n\n## Article B\n<https://example.com/b>\n\n> Other doc.\n\nFollow up\n',
    );
  });
});

describe('reading history', () => {
  const update = (over: Partial<ListeningUpdate>): ListeningUpdate => ({
    source: web('https://example.com/a'),
    index: 5,
    total: 20,
    charsRead: 500,
    charsTotal: 2000,
    addSeconds: 30,
    secondsPerChar: 0.07,
    finished: false,
    now: 1000,
    ...over,
  });

  it('accumulates listening time and keeps the first read date', () => {
    let h: History = {};
    h = withListening(h, update({ now: 1000 }));
    h = withListening(h, update({ now: 2000, addSeconds: 15, index: 7, charsRead: 700 }));
    const e = h['https://example.com/a']!;
    expect(e).toMatchObject({ listenedSeconds: 45, index: 7, firstReadAt: 1000, lastReadAt: 2000 });
    expect(progressOf(e)).toBeCloseTo(0.35);
    expect(remainingSeconds(e)).toBeCloseTo(1300 * 0.07);
  });

  it('lists what to continue: unfinished, really started, most recent first', () => {
    let h: History = {};
    h = withListening(h, update({ source: web('a'), now: 1 }));
    h = withListening(h, update({ source: web('b'), now: 3 }));
    h = withListening(h, update({ source: web('glance'), now: 4, addSeconds: 5 }));
    h = withListening(h, update({ source: web('done'), now: 5, finished: true }));
    expect(continueList(h).map((e) => e.source.key)).toEqual(['b', 'a']);
  });

  it('forgets the oldest documents past the cap', () => {
    let h: History = {};
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = withListening(h, update({ source: web(`k${i}`), now: i }));
    expect(Object.keys(h)).toHaveLength(MAX_HISTORY);
    expect(h.k0).toBeUndefined();
    expect(h[`k${MAX_HISTORY + 4}`]).toBeDefined();
  });

  it('formats listening time for people', () => {
    expect(formatListeningTime(20)).toBe('under a minute');
    expect(formatListeningTime(12 * 60)).toBe('12 min');
    expect(formatListeningTime(65 * 60)).toBe('1 h 5 min');
  });
});

describe('note filters and tags', () => {
  const rust = web('https://doc.rust-lang.org/book/ch03.html', 'Functions');
  rust.site = 'doc.rust-lang.org';
  const mdn = web('https://developer.mozilla.org/x', 'MDN');
  mdn.site = 'developer.mozilla.org';
  const notes = [
    note({ id: '1', source: rust, text: 'snake case', tags: ['rust-book'] }),
    note({ id: '2', source: rust, text: 'expressions return', tags: ['rust-book', 'exam'] }),
    note({ id: '3', source: mdn, text: 'fetch api' }),
  ];

  it('narrows by site and tag, and finds tags by search', () => {
    expect(filterNotes(notes, { site: 'doc.rust-lang.org' }).map((n) => n.id)).toEqual(['1', '2']);
    expect(filterNotes(notes, { tag: 'exam' }).map((n) => n.id)).toEqual(['2']);
    expect(filterNotes(notes, { query: 'rust-book', site: 'developer.mozilla.org' })).toEqual([]);
    expect(searchNotes(notes, 'exam').map((n) => n.id)).toEqual(['2']);
  });

  it('counts sites and tags for the filter menus', () => {
    expect(noteFacets(notes)).toEqual({
      sites: [['doc.rust-lang.org', 2], ['developer.mozilla.org', 1]],
      tags: [['rust-book', 2], ['exam', 1]],
    });
  });

  it('cleans up typed tags', () => {
    expect(parseTags('Rust Book, exam ,, rust-book')).toEqual(['rust-book', 'exam']);
    expect(parseTags('')).toEqual([]);
  });

  it('exports tags in Markdown', () => {
    expect(notesToMarkdown([notes[1]!])).toContain('#rust-book #exam');
  });

  it('writes a notes file that reads back as the same notes', () => {
    const back = parseNotesFile(notesToFile(notes));
    expect(back.map((n) => n.id)).toEqual(notes.map((n) => n.id));
    expect(back[1]!.tags).toEqual(notes[1]!.tags);
  });

  it('reads notes out of a whole backup, or a bare list, and says so when there are none', () => {
    expect(parseNotesFile(JSON.stringify({ format: 'aloud-backup', notes }))).toHaveLength(notes.length);
    expect(parseNotesFile(JSON.stringify(notes))).toHaveLength(notes.length);
    expect(() => parseNotesFile('{"notes":[]}')).toThrow(/No notes/);
    expect(() => parseNotesFile('nonsense')).toThrow(/not JSON/);
  });

  it('finds the notes for one page', () => {
    expect(notesForPage(notes, 'https://developer.mozilla.org/x').map((n) => n.id)).toEqual(['3']);
  });
});

describe('note 5,001', async () => {
  const { MAX_NOTES } = await import('@/shared/notes');
  it('is refused, and every kept note stays', () => {
    const full = Array.from({ length: MAX_NOTES }, (_, i) => note({ id: `old${i}`, createdAt: i, text: `t${i}` }));
    const r = withNoteAdded(full, note({ id: 'new', createdAt: 1e12, text: 'new one' }));
    expect(r.full).toBe(true);
    expect(r.notes).toHaveLength(MAX_NOTES);
    expect(r.notes.some((n) => n.id === 'new')).toBe(false);
    expect(r.notes.some((n) => n.id === 'old0')).toBe(true);
  });
});
