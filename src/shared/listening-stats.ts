/**
 * Listening statistics: what was heard, by day, site and language — the Library's Statistics.
 *
 * Only audio that actually played counts. The reader adds a sentence when its audio finishes,
 * and the part heard when it is paused, sought away from or closed mid-sentence; synthesis queued
 * ahead, buffering, a sentence skipped or hidden, and "Save as MP3" add nothing. Days are the
 * reader's local days, decided when the audio is heard.
 *
 * Kept apart from reading history (shared/reading-history.ts), which has a total per document
 * from before this existed: those totals are shown as what they are, never spread over days that
 * were not recorded. `since` says when counting began.
 *
 * A backup carries these. Each browser profile counts in a bucket of its own (its `origin`), and
 * a day's totals, sites and languages are always sums over its buckets — so they agree. Restoring
 * merges bucket by bucket: the same origin's counts only ever grow, so the larger is the truth
 * (restoring the same file twice, or an older one, changes nothing); another device's bucket
 * simply joins. Nothing is counted twice, and nothing heard elsewhere is lost.
 *
 * On this device only, in `storage.local`, like everything else Aloud keeps.
 */
import { storage } from 'wxt/utils/storage';
import { withStorageLock } from './storage-lock';

export interface Tally {
  seconds: number;
  words: number;
}

/** One profile's listening on one day. */
export interface Bucket extends Tally {
  /** By site (hostname); '' for a document with none (a local PDF). */
  sites: Record<string, Tally>;
  /** By primary language (`it`); '' when it could not be told. */
  languages: Record<string, Tally>;
  /** Documents read to the end that day, by key. */
  completed: string[];
}

/** A day: the sum of its buckets (top level), and the buckets themselves, by origin. */
export interface DayStats extends Bucket {
  origins: Record<string, Bucket>;
}

export interface ListeningStats {
  /** When counting began (ms). */
  since: number;
  /** This profile's bucket name: what it hears is counted there. */
  origin: string;
  /** By local day, `YYYY-MM-DD`. */
  days: Record<string, DayStats>;
}

/** Something heard, as the reader reports it. */
export interface Heard {
  at: number;
  seconds: number;
  words: number;
  site: string;
  language: string;
}

/** About three years of days; older ones fall off. */
export const MAX_DAYS = 1100;
/** Per day: the sites and languages listened to most, so a day can never grow without bound. */
const MAX_KEYS_PER_DAY = 100;

/** The local day of `t`, as `YYYY-MM-DD`. */
export function dayKey(t: number): string {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Words in `text`, as the language counts them (Chinese and Japanese have no spaces). */
export function countWords(text: string, language = ''): number {
  try {
    const seg = new Intl.Segmenter(language || undefined, { granularity: 'word' });
    let n = 0;
    for (const s of seg.segment(text)) if (s.isWordLike) n++;
    return n;
  } catch {
    return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
}

/** Data from before buckets existed: one bucket, the same name everywhere, merged by maximum. */
const LEGACY_ORIGIN = 'legacy';

function newOrigin(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function emptyStats(now: number, origin = newOrigin()): ListeningStats {
  return { since: now, origin, days: {} };
}

function emptyBucket(): Bucket {
  return { seconds: 0, words: 0, sites: {}, languages: {}, completed: [] };
}

function cloneBucket(b: Bucket | undefined): Bucket {
  if (!b) return emptyBucket();
  return {
    seconds: b.seconds,
    words: b.words,
    sites: Object.fromEntries(Object.entries(b.sites).map(([k, t]) => [k, { ...t }])),
    languages: Object.fromEntries(Object.entries(b.languages).map(([k, t]) => [k, { ...t }])),
    completed: [...b.completed],
  };
}

/** A day from its buckets: every figure at the top is the sum of the same figure below. */
function dayOf(origins: Record<string, Bucket>): DayStats {
  const day: DayStats = { ...emptyBucket(), origins };
  const completed = new Set<string>();
  for (const b of Object.values(origins)) {
    day.seconds += b.seconds;
    day.words += b.words;
    for (const [k, t] of Object.entries(b.sites)) add(day.sites, k, t.seconds, t.words);
    for (const [k, t] of Object.entries(b.languages)) add(day.languages, k, t.seconds, t.words);
    for (const c of b.completed) completed.add(c);
  }
  day.completed = [...completed];
  return day;
}

function add(map: Record<string, Tally>, key: string, seconds: number, words: number): void {
  const t = map[key] ?? (map[key] = { seconds: 0, words: 0 });
  t.seconds += seconds;
  t.words += words;
}

function bounded(map: Record<string, Tally>): Record<string, Tally> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_KEYS_PER_DAY) return map;
  return Object.fromEntries(keys.sort((a, b) => map[b]!.seconds - map[a]!.seconds).slice(0, MAX_KEYS_PER_DAY).map((k) => [k, map[k]!]));
}

function prune(days: Record<string, DayStats>): Record<string, DayStats> {
  const keys = Object.keys(days);
  if (keys.length <= MAX_DAYS) return days;
  return Object.fromEntries(keys.sort().slice(-MAX_DAYS).map((k) => [k, days[k]!]));
}

/** `stats` with `heard` added to this profile's bucket. Pure. */
export function withHeard(stats: ListeningStats, heard: readonly Heard[]): ListeningStats {
  const days = { ...stats.days };
  for (const h of heard) {
    if (!(h.seconds > 0) || !Number.isFinite(h.seconds)) continue;
    const key = dayKey(h.at);
    const origins = { ...(days[key]?.origins ?? {}) };
    const bucket = (origins[stats.origin] = cloneBucket(origins[stats.origin]));
    const words = Math.max(0, h.words);
    bucket.seconds += h.seconds;
    bucket.words += words;
    add(bucket.sites, h.site, h.seconds, words);
    add(bucket.languages, h.language, h.seconds, words);
    bucket.sites = bounded(bucket.sites);
    bucket.languages = bounded(bucket.languages);
    days[key] = dayOf(origins);
  }
  return { ...stats, days: prune(days) };
}

/** `stats` with document `key` finished at `at` — once per day, however often it is replayed. */
export function withCompleted(stats: ListeningStats, key: string, at: number): ListeningStats {
  const day = dayKey(at);
  if (!key || stats.days[day]?.completed.includes(key)) return stats;
  const origins = { ...(stats.days[day]?.origins ?? {}) };
  const bucket = (origins[stats.origin] = cloneBucket(origins[stats.origin]));
  bucket.completed.push(key);
  return { ...stats, days: prune({ ...stats.days, [day]: dayOf(origins) }) };
}

/**
 * A backup's statistics merged into these, bucket by bucket: for a profile both sides know, the
 * larger figure (its counts only grow, so that is the later state of the same listening); for one
 * only the backup knows, its bucket joins. Totals are then sums again. Idempotent.
 */
export function mergeStats(here: ListeningStats, other: ListeningStats): ListeningStats {
  const days: Record<string, DayStats> = { ...here.days };
  const maxMap = (a: Record<string, Tally>, b: Record<string, Tally>): Record<string, Tally> => {
    const out: Record<string, Tally> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      out[k] = { seconds: Math.max(a[k]?.seconds ?? 0, b[k]?.seconds ?? 0), words: Math.max(a[k]?.words ?? 0, b[k]?.words ?? 0) };
    }
    return bounded(out);
  };
  for (const [key, theirs] of Object.entries(other.days)) {
    const origins: Record<string, Bucket> = { ...(days[key]?.origins ?? {}) };
    for (const [origin, b] of Object.entries(theirs.origins)) {
      const ours = origins[origin];
      origins[origin] = !ours
        ? cloneBucket(b)
        : {
            seconds: Math.max(ours.seconds, b.seconds),
            words: Math.max(ours.words, b.words),
            sites: maxMap(ours.sites, b.sites),
            languages: maxMap(ours.languages, b.languages),
            completed: [...new Set([...ours.completed, ...b.completed])],
          };
    }
    days[key] = dayOf(origins);
  }
  return { since: Math.min(here.since, other.since), origin: here.origin, days: prune(days) };
}

export interface StatsSummary extends Tally {
  completed: number;
  /** Every day in the range, oldest first, including days with nothing heard. */
  daily: Array<{ day: string } & Tally>;
  /** Most listened first. */
  sites: Array<{ key: string } & Tally>;
  languages: Array<{ key: string } & Tally>;
}

/** Totals and breakdowns for the days from `from` to `to` (inclusive, `YYYY-MM-DD`). */
export function summarize(stats: ListeningStats, from: string, to: string): StatsSummary {
  const summary: StatsSummary = { seconds: 0, words: 0, completed: 0, daily: [], sites: [], languages: [] };
  const sites: Record<string, Tally> = {};
  const languages: Record<string, Tally> = {};
  for (const day of daysBetween(from, to)) {
    const d = stats.days[day];
    summary.daily.push({ day, seconds: d?.seconds ?? 0, words: d?.words ?? 0 });
    if (!d) continue;
    summary.seconds += d.seconds;
    summary.words += d.words;
    summary.completed += d.completed.length;
    for (const [k, t] of Object.entries(d.sites)) add(sites, k, t.seconds, t.words);
    for (const [k, t] of Object.entries(d.languages)) add(languages, k, t.seconds, t.words);
  }
  const ranked = (m: Record<string, Tally>) =>
    Object.entries(m)
      .map(([key, t]) => ({ key, ...t }))
      .sort((a, b) => b.seconds - a.seconds);
  summary.sites = ranked(sites);
  summary.languages = ranked(languages);
  return summary;
}

/** Every local day from `from` to `to`, inclusive. At most MAX_DAYS. */
export function daysBetween(from: string, to: string): string[] {
  const parse = (s: string): Date => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y!, (m ?? 1) - 1, d ?? 1, 12); // noon: no daylight-saving edge lands on midnight
  };
  const out: string[] = [];
  const end = parse(to);
  for (const at = parse(from); at <= end && out.length < MAX_DAYS; at.setDate(at.getDate() + 1)) out.push(dayKey(at.getTime()));
  return out;
}

/** Statistics from storage or a backup, with anything malformed dropped. */
export function normalizeStats(raw: unknown, now = Date.now()): ListeningStats {
  const r = raw as (Partial<ListeningStats> & { days?: Record<string, unknown> }) | null;
  if (!r || typeof r !== 'object') return emptyStats(now);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const tallies = (v: unknown): Record<string, Tally> => {
    const out: Record<string, Tally> = {};
    if (!v || typeof v !== 'object') return out;
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k !== 'string' || k.length > 255 || !t || typeof t !== 'object') continue;
      out[k] = { seconds: num((t as Tally).seconds), words: num((t as Tally).words) };
    }
    return bounded(out);
  };
  const bucket = (v: unknown): Bucket => {
    const b = (v && typeof v === 'object' ? v : {}) as Partial<Bucket>;
    return {
      seconds: num(b.seconds),
      words: num(b.words),
      sites: tallies(b.sites),
      languages: tallies(b.languages),
      completed: Array.isArray(b.completed) ? [...new Set(b.completed.filter((c): c is string => typeof c === 'string'))] : [],
    };
  };
  const validOrigin = (o: unknown): o is string => typeof o === 'string' && /^[\w-]{1,64}$/.test(o);
  const days: Record<string, DayStats> = {};
  if (r.days && typeof r.days === 'object') {
    for (const [key, d] of Object.entries(r.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !d || typeof d !== 'object') continue;
      const day = d as Partial<DayStats>;
      const origins: Record<string, Bucket> = {};
      if (day.origins && typeof day.origins === 'object') {
        for (const [o, b] of Object.entries(day.origins)) if (validOrigin(o)) origins[o] = bucket(b);
      } else {
        // Counted before buckets: one bucket, under the same name on every device.
        origins[LEGACY_ORIGIN] = bucket(day);
      }
      days[key] = dayOf(origins);
    }
  }
  const since = typeof r.since === 'number' && Number.isFinite(r.since) && r.since > 0 ? Math.min(r.since, now) : now;
  return { since, origin: validOrigin(r.origin) ? r.origin : newOrigin(), days: prune(days) };
}

// ---- storage ---------------------------------------------------------------------------------

export const STATS_STORAGE_KEY = 'listeningStats';
const item = storage.defineItem<ListeningStats | null>(`local:${STATS_STORAGE_KEY}`, { fallback: null });

/** The statistics kept here; counting begins now if it had not. */
export async function loadStats(): Promise<ListeningStats> {
  try {
    return normalizeStats(await item.getValue());
  } catch {
    return emptyStats(Date.now());
  }
}

/** Add what the reader heard. Many readers in many tabs write here, one at a time. */
export function recordHeard(heard: readonly Heard[]): Promise<void> {
  if (heard.length === 0) return Promise.resolve();
  return withStorageLock('stats', async () => {
    await item.setValue(withHeard(await loadStats(), heard));
  }).catch(() => undefined);
}

export function recordCompleted(key: string, at = Date.now()): Promise<void> {
  return withStorageLock('stats', async () => {
    await item.setValue(withCompleted(await loadStats(), key, at));
  }).catch(() => undefined);
}

/** Forget every figure; counting starts again from now. */
export async function clearStats(): Promise<void> {
  await withStorageLock('stats', () => item.setValue(emptyStats(Date.now())));
}

/** A backup's statistics, merged in (see `mergeStats`). */
export async function restoreStats(other: ListeningStats): Promise<void> {
  await withStorageLock('stats', async () => {
    await item.setValue(mergeStats(await loadStats(), other));
  });
}

export function watchStats(cb: (stats: ListeningStats) => void): () => void {
  return item.watch((value) => cb(normalizeStats(value)));
}
