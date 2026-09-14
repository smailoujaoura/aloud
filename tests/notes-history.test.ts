import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { groupBySource, notesToMarkdown, searchNotes, withNoteAdded, withNoteRemoved, withNoteUpdated, type Note } from '@/shared/notes';
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
