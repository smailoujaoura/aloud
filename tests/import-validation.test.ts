/**
 * The audit's A05 and A15: what an imported file is allowed to put into storage.
 */
import { describe, expect, it } from 'vitest';
import { normalizeNote, notesToMarkdown, parseNotesFile, type Note } from '@/shared/notes';
import { mergeNotes, mergeQueue, overflowOf, parseBackup, restoredSettings } from '@/shared/backup';
import { sourceUrl } from '@/shared/doc-source';
import { MAX_NOTES } from '@/shared/notes';
import { MAX_QUEUE, type QueueItem } from '@/shared/reading-queue';

const queued = (id: string, url: string): QueueItem => ({ id, url, title: id, site: 'x', addedAt: 1 });

describe('importing notes', () => {
  it('fills in a record that only has a passage and a page, and keeps it usable', () => {
    // The exact record the audit imported: it was stored, then broke the Notes view.
    const notes = parseNotesFile(JSON.stringify([{ id: 'audit', text: 'A passage', source: { key: 'https://example.com/a' } }]));
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note.source.reopen).toEqual({ kind: 'web', url: 'https://example.com/a' });
    expect(note.comment).toBe('');
    expect(note.tags).toEqual([]);
    expect(sourceUrl(note.source)).toBe('https://example.com/a');
    expect(() => notesToMarkdown(notes)).not.toThrow();
  });

  it('refuses records with nothing to show, rather than storing them', () => {
    expect(normalizeNote({ id: 'x' })).toBeNull();
    expect(normalizeNote({ text: 'no source' })).toBeNull();
    expect(normalizeNote({ text: 'unopenable', source: { key: 'not-a-url' } })).toBeNull();
    expect(() => parseNotesFile(JSON.stringify([{ id: 'x' }]))).toThrow(/No notes/);
  });

  it('survives a note whose source lost its reopen', () => {
    expect(sourceUrl({ key: 'k', title: 't', site: 's' } as never)).toBeNull();
  });
});

describe('restoring a backup', () => {
  const backupOf = (extra: Record<string, unknown>) =>
    parseBackup(JSON.stringify({ format: 'aloud-backup', version: 1, settingsVersion: 6, ...extra }));

  it('refuses settings values that cannot mean anything', () => {
    const b = backupOf({ settings: { speed: -3, engine: 'nonsense', annotate: { colors: null }, mediaSpeed: { presets: ['fast'] } } });
    const settings = restoredSettings(b)!;
    expect(settings.speed).toBeGreaterThan(0);
    expect(['piper', 'kokoro', 'supertonic']).toContain(settings.engine);
    expect(settings.annotate.colors.length).toBeGreaterThan(0);
    expect(settings.mediaSpeed.presets.every((p) => typeof p === 'number')).toBe(true);
  });

  it('drops queued entries without a usable address', () => {
    const b = backupOf({ queue: [{ id: 'a' }, { id: 'b', url: 'not a url' }, { id: 'c', url: 'https://ok/' }] });
    expect(b.queue.map((q) => q.id)).toEqual(['c']);
  });

  it('does not queue the same article twice from one file', () => {
    const merged = mergeQueue([], [queued('1', 'https://a/x'), queued('2', 'https://a/x?utm_source=mail'), queued('3', 'https://b/y')]);
    expect(merged.map((q) => q.id)).toEqual(['1', '3']);
  });

  it('keeps existing notes when the merge is over the cap', () => {
    const note = (id: string, createdAt: number): Note => ({
      id,
      text: id,
      comment: '',
      source: { key: 'k', title: 't', site: 's', reopen: { kind: 'web', url: 'https://s/' } },
      at: null,
      createdAt,
      updatedAt: createdAt,
    });
    const mine = Array.from({ length: MAX_NOTES }, (_, i) => note(`mine-${i}`, i));
    const theirs = Array.from({ length: 10 }, (_, i) => note(`theirs-${i}`, 10_000 + i));
    const merged = mergeNotes(mine, theirs);
    expect(merged).toHaveLength(MAX_NOTES);
    expect(merged.filter((n) => n.id.startsWith('mine-'))).toHaveLength(MAX_NOTES);
    // …and the page can say what it could not take.
    const b = backupOf({ notes: theirs });
    expect(overflowOf(b, { notes: mine }).notes).toBe(10);
  });

  it('stops a restore at the queue capacity and says how many were left', () => {
    const here = Array.from({ length: MAX_QUEUE }, (_, i) => queued(`here-${i}`, `https://here/${i}`));
    const merged = mergeQueue(here, [queued('new', 'https://new/1')]);
    expect(merged).toHaveLength(MAX_QUEUE);
    expect(overflowOf(backupOf({ queue: [queued('new', 'https://new/1')] }), { readingQueue: here }).queue).toBe(1);
  });
});
