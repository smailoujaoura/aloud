/**
 * The pure half of "remember where the reader stopped": identifying a document, fingerprinting a
 * sentence, and deciding whether a saved position can still be trusted.
 *
 * Kept free of extension APIs so it can be unit-tested; `reading-positions.ts` adds the storage.
 *
 * What is stored is deliberately small and coarse: a sentence *index*, the sentence count it was
 * taken against, and a short excerpt of that sentence. The excerpt is the safety check — a page
 * that has been edited since (a live blog, a wiki article) re-plans into a different list, and an
 * index into the old list would land on the wrong sentence. `resumeIndex` only trusts a saved
 * position whose sentence still reads the same.
 */

export interface SavedPosition {
  /** Index into the playlist when the position was saved. */
  index: number;
  /** Playlist length at the time, used to spot a page that has been re-planned. */
  total: number;
  /** Start of the sentence at `index`, normalised, to verify the index still means the same. */
  excerpt: string;
  /** Epoch milliseconds, for recency pruning. */
  savedAt: number;
}

export type PositionMap = Record<string, SavedPosition>;

/** Enough for a reading list's worth of pages without the storage entry growing unbounded. */
export const MAX_SAVED_POSITIONS = 500;
/** Characters of the sentence kept as its fingerprint. */
const EXCERPT_CHARS = 60;
/** Positions this close to the start aren't worth offering to resume. */
const MIN_RESUME_INDEX = 2;

/**
 * A stable key for "this document".
 *
 * The fragment is dropped when it is where on the page (`#section-2`, a `#:~:text=` link), and
 * kept when it is which page: an app that routes by it (`#/article/one`, `#!/post/7`) shows a
 * different article for each. So are dropped the query parameters that only record how someone
 * arrived — `utm_*`, `fbclid` and friends — so the same article shared through two channels
 * resumes in both.
 */
export function documentKey(url: string): string {
  return canonical(url, true);
}

/**
 * The key `documentKey` gave before routes were kept: every fragment dropped. What was saved
 * under it for a routed page moves to the page's own key when that page is read again
 * (shared/former-key.ts); notes find their page by the address they were made on.
 */
export function formerDocumentKey(url: string): string {
  return canonical(url, false);
}

function canonical(url: string, keepRoute: boolean): string {
  try {
    const u = new URL(url);
    const route = keepRoute ? routeOf(u.hash) : '';
    u.hash = '';
    for (const name of [...u.searchParams.keys()]) {
      if (/^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i.test(name)) u.searchParams.delete(name);
    }
    return u.toString() + route;
  } catch {
    return url;
  }
}

/** `#/article/one` and `#!/post/7` are routes; `#/` alone is the app's start, and anything else is a place on the page. */
function routeOf(hash: string): string {
  const route = hash.split(':~:')[0] ?? '';
  return /^#!?\/./.test(route) || /^#![^/]/.test(route) ? route : '';
}

export function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, EXCERPT_CHARS);
}

/**
 * The playlist index to resume at, or null when there is nothing trustworthy to resume.
 *
 * Tries the saved index first, then — if the page has shifted a little (a paragraph inserted
 * above) — the nearest sentence with the same excerpt. Declines positions at the very start (no
 * point asking) and at the very end (the article was finished).
 */
export function resumeIndex(saved: SavedPosition | undefined, sentences: readonly string[]): number | null {
  if (!saved || sentences.length === 0) return null;
  const matches = (i: number): boolean => excerptOf(sentences[i] ?? '') === saved.excerpt;

  let found: number | null = null;
  if (saved.index < sentences.length && matches(saved.index)) {
    found = saved.index;
  } else {
    // Search outwards from where it used to be, so a repeated sentence elsewhere loses to the one
    // nearest the old position.
    for (let d = 1; d < sentences.length && found == null; d++) {
      if (saved.index - d >= 0 && matches(saved.index - d)) found = saved.index - d;
      else if (saved.index + d < sentences.length && matches(saved.index + d)) found = saved.index + d;
    }
  }

  if (found == null || found < MIN_RESUME_INDEX || found >= sentences.length - 1) return null;
  return found;
}

/** Add or replace one entry, keeping only the `max` most recent. */
export function withPosition(map: PositionMap, key: string, pos: SavedPosition, max = MAX_SAVED_POSITIONS): PositionMap {
  const next: PositionMap = { ...map, [key]: pos };
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  keys.sort((a, b) => next[b]!.savedAt - next[a]!.savedAt);
  return Object.fromEntries(keys.slice(0, max).map((k) => [k, next[k]!]));
}
