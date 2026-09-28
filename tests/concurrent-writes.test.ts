/**
 * The audit's A02: two overlapping saves both reported success and kept one change.
 *
 * These drive the real functions against a storage double whose reads and writes take a turn of
 * the event loop, which is what lets two read-modify-write pairs interleave.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const slow = async <T>(value: T): Promise<T> => {
  await new Promise((r) => setTimeout(r, 0));
  return structuredClone(value);
};

vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: <T>(key: string, opts: { fallback?: T }) => ({
      getValue: async () => slow((store.get(key) as T) ?? opts.fallback),
      setValue: async (value: T) => {
        await new Promise((r) => setTimeout(r, 0));
        store.set(key, structuredClone(value));
      },
      watch: () => () => {},
    }),
  },
}));

// No background in a test: the lock falls back to ordering inside this context, which is what
// the interleaving above needs.
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: async () => { throw new Error('no background'); } } } }));

import { addNote, loadNotes, removeNote, type NewNote } from '@/shared/notes';
import { addToQueue, loadQueue } from '@/shared/reading-queue';
import { getSettings, setSettings } from '@/shared/settings';

const note = (text: string): NewNote => ({
  text,
  source: { key: 'k', title: 't', site: 's', reopen: { kind: 'web', url: 'https://s/' } },
  at: null,
});

describe('overlapping writes', () => {
  beforeEach(() => store.clear());

  it('keeps both notes when two are saved at the same moment', async () => {
    const [a, b] = await Promise.all([addNote(note('first')), addNote(note('second'))]);
    expect(a.duplicate || b.duplicate).toBe(false);
    expect((await loadNotes()).map((n) => n.text).sort()).toEqual(['first', 'second']);
  });

  it('keeps a note added while another is being deleted', async () => {
    const { note: first } = await addNote(note('first'));
    await Promise.all([removeNote(first.id), addNote(note('second'))]);
    expect((await loadNotes()).map((n) => n.text)).toEqual(['second']);
  });

  it('keeps both queued articles', async () => {
    await Promise.all([
      addToQueue({ url: 'https://a/', title: 'A', site: 'a' }),
      addToQueue({ url: 'https://b/', title: 'B', site: 'b' }),
    ]);
    expect((await loadQueue()).map((q) => q.title).sort()).toEqual(['A', 'B']);
  });

  it('keeps both settings when two are saved at once', async () => {
    await Promise.all([setSettings({ speed: 1.75 }), setSettings({ theme: 'dark' })]);
    const settings = await getSettings();
    expect([settings.speed, settings.theme]).toEqual([1.75, 'dark']);
  });
});
