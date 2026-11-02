import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, unknown>();
vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: (key: string, opts: { fallback: unknown }) => ({
      getValue: async () => (stored.has(key) ? structuredClone(stored.get(key)) : structuredClone(opts.fallback)),
      setValue: async (v: unknown) => void stored.set(key, structuredClone(v)),
    }),
  },
}));

const { adoptFormerKey, pdfTextKey } = await import('@/shared/former-key');
const { excerptOf, loadPosition, savePosition } = await import('@/shared/reading-positions');
const { loadHistory, recordListening } = await import('@/shared/reading-history');

const sentences = ['The quiet economics of lighthouses.', 'Every coast once had a keeper.', 'Then came the lamps that ran themselves.'];
const position = (sentence: string, index = 1) => ({ index, total: 3, excerpt: excerptOf(sentence), savedAt: 1 });
const heard = (key: string, title: string) =>
  recordListening({ source: { key, title, site: 'report.pdf', reopen: { kind: 'file', name: 'report.pdf' } }, index: 1, total: 3, charsRead: 30, charsTotal: 90, addSeconds: 60, secondsPerChar: null, finished: false, now: 1 });

describe('a PDF known by its text, and what was saved under its file name', () => {
  beforeEach(() => stored.clear());

  it('different text, different key; the same text, the same key wherever it comes from', async () => {
    const a = await pdfTextKey('Quarterly report\nRevenue rose.');
    expect(a).toMatch(/^pdf:text:[0-9a-f]{32}$/);
    expect(await pdfTextKey('Quarterly report\nRevenue rose.')).toBe(a);
    expect(await pdfTextKey('Quarterly report\nRevenue fell.')).not.toBe(a);
  });

  it('this document’s place and history move to its new key', async () => {
    await savePosition('pdf:report.pdf:3', position(sentences[1]!));
    await heard('pdf:report.pdf:3', 'Lighthouses');
    await adoptFormerKey('pdf:report.pdf:3', 'pdf:text:aaa', sentences, 'Lighthouses');
    expect((await loadPosition('pdf:text:aaa'))?.index).toBe(1);
    expect(await loadPosition('pdf:report.pdf:3')).toBeUndefined();
    const history = await loadHistory();
    expect(Object.keys(history)).toEqual(['pdf:text:aaa']);
    expect(history['pdf:text:aaa']?.source.key).toBe('pdf:text:aaa');
    expect(history['pdf:text:aaa']?.listenedSeconds).toBe(60);
  });

  it('another report.pdf with as many pages keeps its own: nothing is taken', async () => {
    await savePosition('pdf:report.pdf:3', position('net revenue fell in the third quarter'));
    await heard('pdf:report.pdf:3', 'Quarterly results');
    await adoptFormerKey('pdf:report.pdf:3', 'pdf:text:bbb', sentences, 'Lighthouses');
    expect(await loadPosition('pdf:text:bbb')).toBeUndefined();
    expect(await loadPosition('pdf:report.pdf:3')).toBeDefined();
    expect(Object.keys(await loadHistory())).toEqual(['pdf:report.pdf:3']);
  });

  it('never overwrites what the new key already has', async () => {
    await savePosition('pdf:text:ccc', position(sentences[2]!, 2));
    await savePosition('pdf:report.pdf:3', position(sentences[1]!));
    await adoptFormerKey('pdf:report.pdf:3', 'pdf:text:ccc', sentences, 'Lighthouses');
    expect((await loadPosition('pdf:text:ccc'))?.index).toBe(2);
  });
});
