import { vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { describe, expect, it } from 'vitest';
import { makeBackup, mergeNotes, mergeQueue, mergeRecords, parseBackup, restorePlan, restoredSettings } from '@/shared/backup';
import type { Note } from '@/shared/notes';

const note = (id: string, updatedAt: number, text = id): Note => ({
  id,
  text,
  comment: '',
  source: { key: 'k', title: 't', site: 's', reopen: { kind: 'web', url: 'https://s/' } },
  at: null,
  createdAt: updatedAt,
  updatedAt,
});

const extra = { aloud: '0.1.0', models: { piper: ['en_GB-alba-medium'], kokoro: true }, shortcuts: { 'save-note': 'Alt+Shift+S' } };

describe('backup', () => {
  it('round-trips through a file', () => {
    const all = {
      settings: { engine: 'kokoro', kokoroVoice: 'af_bella' },
      notes: [note('a', 1)],
      readingQueue: [{ id: 'q', url: 'https://x/', title: 'x', site: 'x', addedAt: 1 }],
      'pdfMarks:abc': { name: 'f.pdf', marks: [], updated: 3 },
      workerWebGPU: true,
    };
    const parsed = parseBackup(JSON.stringify(makeBackup(all, extra)));
    expect(parsed.notes.map((n) => n.id)).toEqual(['a']);
    expect(parsed.queue).toHaveLength(1);
    expect(Object.keys(parsed.pdfMarks)).toEqual(['pdfMarks:abc']);
    expect(parsed.models).toEqual(extra.models);
    // Machine facts are not carried to another machine.
    expect(JSON.stringify(parsed)).not.toContain('workerWebGPU');
  });

  it('refuses files that are not backups', () => {
    expect(() => parseBackup('not json')).toThrow(/not JSON/);
    expect(() => parseBackup('{"format":"other"}')).toThrow(/not an Aloud backup/);
    expect(() => parseBackup('{"format":"aloud-backup","version":99}')).toThrow(/newer Aloud/);
  });

  it('brings old settings up to date and fills in defaults', () => {
    const b = parseBackup(JSON.stringify({ ...makeBackup({ settings: { kokoroDtype: 'fp32', wordHighlight: true, speed: 1.4 } }, extra), settingsVersion: 4 }));
    const s = restoredSettings(b)!;
    expect(s.speed).toBe(1.4);
    expect(s.wordHighlight).toBe('darker');
    expect('kokoroDtype' in s).toBe(false);
    expect(s.annotate.colors.length).toBeGreaterThan(0);
  });

  it('merges notes, keeping the newer copy of each', () => {
    const merged = mergeNotes([note('a', 5, 'mine'), note('b', 1)], [note('a', 2, 'old'), note('c', 3)]);
    expect(merged.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(merged.find((n) => n.id === 'a')!.text).toBe('mine');
  });

  it('adds queued articles that are not already queued', () => {
    const here = [{ id: '1', url: 'https://a/', title: '', site: '', addedAt: 1 }];
    const merged = mergeQueue(here, [{ id: '2', url: 'https://a/', title: '', site: '', addedAt: 2 }, { id: '3', url: 'https://b/', title: '', site: '', addedAt: 3 }]);
    expect(merged.map((q) => q.id)).toEqual(['1', '3']);
  });

  it('keeps the most recent record per key', () => {
    expect(mergeRecords({ x: { lastReadAt: 5 } }, { x: { lastReadAt: 2 }, y: { lastReadAt: 1 } })).toEqual({ x: { lastReadAt: 5 }, y: { lastReadAt: 1 } });
  });

  it('restores only the parts asked for', () => {
    const b = parseBackup(JSON.stringify(makeBackup({ settings: { speed: 2 }, notes: [note('a', 1)] }, extra)));
    const plan = restorePlan(b, {}, new Set(['notes']));
    expect(Object.keys(plan)).toEqual(['notes']);
  });
});

describe('backup: listening statistics', () => {
  const day = (seconds: number) => ({ seconds, words: seconds * 2, sites: { 'a.it': { seconds, words: seconds * 2 } }, languages: { it: { seconds, words: seconds * 2 } }, completed: ['doc'] });

  it('travels with the Library part, and restoring the same file twice counts nothing twice', () => {
    const file = parseBackup(JSON.stringify(makeBackup({ listeningStats: { since: 100, days: { '2026-10-01': day(60) } } }, extra)));
    expect(file.stats?.days['2026-10-01']?.seconds).toBe(60);
    const here: Record<string, unknown> = { listeningStats: { since: 500, days: { '2026-10-01': day(40), '2026-10-02': day(10) } } };
    const first = restorePlan(file, here, new Set(['library']));
    const second = restorePlan(file, { ...here, ...first }, new Set(['library']));
    expect(second.listeningStats).toEqual(first.listeningStats);
    const merged = first.listeningStats as { since: number; days: Record<string, { seconds: number; completed: string[] }> };
    expect(merged.since).toBe(100);
    expect(merged.days['2026-10-01']!.seconds).toBe(60);
    expect(merged.days['2026-10-02']!.seconds).toBe(10);
    expect(merged.days['2026-10-01']!.completed).toEqual(['doc']);
  });

  it('an older file without statistics leaves them alone', () => {
    const file = parseBackup(JSON.stringify({ ...makeBackup({}, extra), stats: undefined }));
    expect(file.stats).toBeNull();
    expect(restorePlan(file, { listeningStats: { since: 1, days: {} } }, new Set(['library'])).listeningStats).toBeUndefined();
  });
});
