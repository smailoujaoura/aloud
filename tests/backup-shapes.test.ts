import { describe, expect, it } from 'vitest';
import { parseBackup, restoredSettings, restorePlan } from '@/shared/backup';
import { continueList, loadHistory } from '@/shared/reading-history';
import { formatBinding } from '@/media-speed/keys';
import { getSettings } from '@/shared/settings';
import { storage } from 'wxt/utils/storage';
import { resetStorage } from './stubs/wxt-storage';

const backup = (extra: Record<string, unknown>) =>
  parseBackup(JSON.stringify({ format: 'aloud-backup', version: 1, ...extra }));
const source = { key: 'https://a.test/x', title: 'X', site: 'a.test', reopen: { kind: 'web', url: 'https://a.test/x' } };

describe('a backup cannot store values the extension then trips over', () => {
  it('a key binding that is not text falls back to its default', () => {
    const settings = restoredSettings(backup({ settings: { mediaSpeed: { keys: { faster: 7, slower: 'x' } } } }))!;
    expect(settings.mediaSpeed.keys.faster).toBe('d');
    expect(settings.mediaSpeed.keys.slower).toBe('x');
    expect(() => formatBinding(settings.mediaSpeed.keys.faster)).not.toThrow();
  });

  it('settings already damaged in storage are repaired when read', async () => {
    resetStorage();
    await storage.setItem('local:settings', { mediaSpeed: { keys: { faster: 7 } }, annotate: { pageKeys: { keep: 5 } } });
    const s = await getSettings();
    expect(s.mediaSpeed.keys.faster).toBe('d');
    expect(s.annotate.pageKeys.keep).toBe('k');
  });

  it('a null or shapeless history entry is dropped, and the Library list still works', () => {
    const b = backup({
      history: {
        broken: null,
        alsoBroken: { source: null, index: 3 },
        good: { source, index: 4, total: 10, listenedSeconds: 60, lastReadAt: 5, finished: false },
      },
    });
    expect(Object.keys(b.history)).toEqual(['good']);
    const plan = restorePlan(b, {}, new Set(['library']));
    expect(() => continueList(plan.readingHistory as never)).not.toThrow();
  });

  it('history already damaged in storage is repaired when read', async () => {
    resetStorage();
    await storage.setItem('local:readingHistory', { broken: null });
    const history = await loadHistory();
    expect(history).toEqual({});
    expect(() => continueList(history)).not.toThrow();
  });

  it('positions, site speeds and PDF marks keep only well-formed records', () => {
    const b = backup({
      positions: { a: { index: 2, total: 9, excerpt: 'hi', savedAt: 1 }, b: { index: 'two' }, c: null },
      siteSpeeds: { 'a.test': { rate: 1.5, at: 1 }, 'b.test': { rate: -3 }, 'c.test': 'fast' },
      pdfMarks: {
        'pdfMarks:abc': {
          name: 'f.pdf',
          updated: 1,
          marks: [
            { id: 'm1', page: 1, kind: 'highlight', color: '#ff0', boxes: [[0, 0, 1, 1]], text: 't', note: '', created: 1, updated: 1 },
            { id: 'm2', page: 1, kind: 'scribble', color: '#ff0', boxes: [] },
            { id: 'm3', page: 1, kind: 'note', color: '#ff0', boxes: [[0, 'x', 1, 1]] },
          ],
        },
        'pdfMarks:def': 'nonsense',
      },
    });
    expect(Object.keys(b.positions)).toEqual(['a']);
    expect(Object.keys(b.siteSpeeds)).toEqual(['a.test']);
    expect(Object.keys(b.pdfMarks)).toEqual(['pdfMarks:abc']);
    expect((b.pdfMarks['pdfMarks:abc'] as { marks: { id: string }[] }).marks.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('importing notes at the cap', async () => {
  const { MAX_NOTES, mergeInNotes, loadNotes } = await import('@/shared/notes');
  const note = (id: string, createdAt: number) => ({
    id, text: id, comment: '', source, at: null, createdAt, updatedAt: createdAt,
  });

  it('keeps every note already here, and says how many did not fit', async () => {
    resetStorage();
    const mine = Array.from({ length: MAX_NOTES }, (_, i) => note(`old${i}`, 1));
    await storage.setItem('local:notes', mine);
    const result = await mergeInNotes([note('new', 2) as never]);
    const stored = await loadNotes();
    expect(result).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(stored).toHaveLength(MAX_NOTES);
    expect(stored.every((n) => n.id.startsWith('old'))).toBe(true);
  });

  it('still updates a note it already has, at the cap', async () => {
    resetStorage();
    const mine = Array.from({ length: MAX_NOTES }, (_, i) => note(`old${i}`, 1));
    await storage.setItem('local:notes', mine);
    const result = await mergeInNotes([{ ...note('old0', 1), text: 'edited', updatedAt: 9 } as never]);
    expect(result).toEqual({ added: 0, updated: 1, skipped: 0 });
    expect((await loadNotes()).find((n) => n.id === 'old0')?.text).toBe('edited');
  });

  it('below the cap, fills the room left with the newest', async () => {
    resetStorage();
    const mine = Array.from({ length: MAX_NOTES - 1 }, (_, i) => note(`old${i}`, 1));
    await storage.setItem('local:notes', mine);
    const result = await mergeInNotes([note('a', 2), note('b', 3)] as never);
    expect(result).toEqual({ added: 1, updated: 0, skipped: 1 });
    const ids = (await loadNotes()).map((n) => n.id);
    expect(ids).toContain('b');
    expect(ids.filter((id) => id.startsWith('old'))).toHaveLength(MAX_NOTES - 1);
  });
});
