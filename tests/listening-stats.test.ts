import { describe, it, expect } from 'vitest';
import {
  countWords,
  dayKey,
  emptyStats,
  mergeStats,
  normalizeStats,
  summarize,
  withCompleted,
  withHeard,
  type Heard,
} from '@/shared/listening-stats';
import { rangeOf } from '@/library/stats-panel';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const heard = (t: number, seconds: number, words: number, site = 'example.com', language = 'en'): Heard => ({ at: t, seconds, words, site, language });

describe('listening statistics', () => {
  it('buckets by the local day the audio was heard, either side of midnight', () => {
    let s = emptyStats(at(2026, 10, 1));
    s = withHeard(s, [heard(at(2026, 10, 1, 23, 59), 30, 70), heard(at(2026, 10, 2, 0, 1), 20, 40)]);
    expect(Object.keys(s.days).sort()).toEqual(['2026-10-01', '2026-10-02']);
    expect(s.days['2026-10-01']!.seconds).toBe(30);
    expect(s.days['2026-10-02']!.words).toBe(40);
  });

  it('keeps sites and languages, with an explicit unknown for each', () => {
    const s = withHeard(emptyStats(0), [heard(at(2026, 10, 1), 60, 150, 'a.it', 'it'), heard(at(2026, 10, 1), 30, 80, '', '')]);
    const day = s.days['2026-10-01']!;
    expect(day.sites).toEqual({ 'a.it': { seconds: 60, words: 150 }, '': { seconds: 30, words: 80 } });
    expect(day.languages['']).toEqual({ seconds: 30, words: 80 });
  });

  it('adds nothing for audio that did not play', () => {
    const s = withHeard(emptyStats(0), [heard(at(2026, 10, 1), 0, 10), heard(at(2026, 10, 1), Number.NaN, 5)]);
    expect(s.days).toEqual({});
  });

  it('counts a finished document once a day, however often it is replayed', () => {
    let s = emptyStats(0);
    s = withCompleted(s, 'doc', at(2026, 10, 1, 9));
    s = withCompleted(s, 'doc', at(2026, 10, 1, 21));
    s = withCompleted(s, 'doc', at(2026, 10, 2, 9));
    expect(s.days['2026-10-01']!.completed).toEqual(['doc']);
    expect(summarize(s, '2026-10-01', '2026-10-02').completed).toBe(2);
  });

  it('restoring this profile\'s own backup twice counts nothing twice, and an older one takes nothing away', () => {
    const earlier = withHeard(emptyStats(at(2026, 9, 1), 'me'), [heard(at(2026, 10, 1), 60, 150)]);
    const now = withHeard(earlier, [heard(at(2026, 10, 1), 40, 100), heard(at(2026, 10, 3), 50, 120)]);
    const once = mergeStats(now, earlier);
    expect(mergeStats(once, earlier)).toEqual(once);
    expect(once.days['2026-10-01']!.seconds).toBe(100);
    expect(once.days['2026-10-03']!.seconds).toBe(50);
  });

  it('another device\'s listening adds, and the totals still equal every breakdown', () => {
    // The reviewer's case: 10 s on site A in Italian here, 20 s on site B in English in a backup.
    const here = withHeard(emptyStats(at(2026, 9, 1), 'laptop'), [heard(at(2026, 10, 1), 10, 20, 'a.it', 'it')]);
    const backup = withHeard(emptyStats(at(2026, 8, 1), 'phone'), [heard(at(2026, 10, 1), 20, 40, 'b.org', 'en')]);
    const merged = mergeStats(here, backup);
    const day = merged.days['2026-10-01']!;
    const sum = (m: Record<string, { seconds: number }>) => Object.values(m).reduce((n, t) => n + t.seconds, 0);
    expect(day.seconds).toBe(30);
    expect(sum(day.sites)).toBe(30);
    expect(sum(day.languages)).toBe(30);
    expect(merged.since).toBe(at(2026, 8, 1));
    expect(merged.origin).toBe('laptop');
    // Partly overlapping: the phone's backup restored again after this laptop's was merged into it.
    const phoneLater = mergeStats(withHeard(backup, [heard(at(2026, 10, 1), 5, 10, 'b.org', 'en')]), here);
    const again = mergeStats(merged, phoneLater);
    expect(again.days['2026-10-01']!.seconds).toBe(35);
    expect(sum(again.days['2026-10-01']!.sites)).toBe(35);
    expect(mergeStats(again, phoneLater)).toEqual(again);
  });

  it('totals, the chart and both breakdowns reconcile', () => {
    const s = withHeard(emptyStats(0), [
      heard(at(2026, 10, 1), 60, 150, 'a.it', 'it'),
      heard(at(2026, 10, 2), 30, 70, 'b.org', 'en'),
      heard(at(2026, 10, 2), 15, 30, '', ''),
    ]);
    const sum = summarize(s, '2026-09-30', '2026-10-02');
    const total = (rows: Array<{ seconds: number }>) => rows.reduce((n, r) => n + r.seconds, 0);
    expect(sum.seconds).toBe(105);
    expect(total(sum.daily)).toBe(105);
    expect(total(sum.sites)).toBe(105);
    expect(total(sum.languages)).toBe(105);
    expect(sum.daily.map((d) => d.day)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(sum.sites[0]!.key).toBe('a.it');
  });

  it('drops anything malformed from storage or a file', () => {
    const s = normalizeStats({
      since: 'yesterday',
      days: {
        '2026-10-01': { seconds: 10, words: -3, sites: { x: { seconds: 'a' } }, languages: null, completed: ['d', 4, 'd'] },
        'not-a-day': { seconds: 99 },
      },
    }, at(2026, 10, 12));
    expect(Object.keys(s.days)).toEqual(['2026-10-01']);
    expect(s.days['2026-10-01']).toMatchObject({ seconds: 10, words: 0, sites: { x: { seconds: 0, words: 0 } }, languages: {}, completed: ['d'] });
    // Counted before buckets existed: kept, in the one bucket every device names the same.
    expect(Object.keys(s.days['2026-10-01']!.origins)).toEqual(['legacy']);
    expect(s.since).toBe(at(2026, 10, 12));
    expect(normalizeStats(null, 5)).toMatchObject({ since: 5, days: {} });
  });

  it('counts words as the language does', () => {
    expect(countWords('Lasciate che vi racconti la storia.', 'it')).toBe(6);
    expect(countWords('我今天很高兴', 'zh')).toBeGreaterThan(1);
  });

  it('ranges: the last N local days, since counting began, or chosen dates', () => {
    const now = at(2026, 10, 12, 8);
    const s = emptyStats(at(2026, 9, 20));
    expect(rangeOf('7', s, '', '', now)).toEqual(['2026-10-06', '2026-10-12']);
    expect(rangeOf('all', s, '', '', now)).toEqual(['2026-09-20', '2026-10-12']);
    expect(rangeOf('custom', s, '2026-10-05', '2026-10-01', now)).toEqual(['2026-10-01', '2026-10-05']);
    expect(dayKey(now)).toBe('2026-10-12');
  });
});
