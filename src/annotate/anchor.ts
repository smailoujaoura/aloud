/**
 * Finding a highlighted passage again when the page is opened another day.
 *
 * A highlight is stored as the text itself plus a little of what comes before and after it
 * (the W3C "text quote" idea, as Hypothesis and browsers' own text fragments do), never as a DOM
 * path: documentation gets edited, sites change their templates, ads come and go, and any path
 * into the DOM breaks with them. Text survives all of that unless the words themselves change.
 *
 * Matching works on the page text with runs of whitespace collapsed to one space, since the same
 * page can render with different whitespace (a reflowed template, a different browser). When the
 * quote occurs more than once, the occurrence whose surroundings match best wins, and ties go to
 * the one nearest where it used to be.
 */

export interface TextAnchor {
  /** The highlighted text, whitespace collapsed. */
  exact: string;
  /** Up to CONTEXT characters immediately before and after it. */
  prefix: string;
  suffix: string;
  /** Where it started in the collapsed page text, to break ties between identical quotes. */
  start: number;
}

export const CONTEXT = 32;

/** Page text with whitespace runs collapsed, and for each character its offset in the original. */
interface Collapsed {
  text: string;
  toRaw: number[];
}

function collapse(raw: string): Collapsed {
  let text = '';
  const toRaw: number[] = [];
  let lastWasSpace = true; // drops leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue;
      text += ' ';
      toRaw.push(i);
      lastWasSpace = true;
    } else {
      text += ch;
      toRaw.push(i);
      lastWasSpace = false;
    }
  }
  return { text, toRaw };
}

/** First collapsed index at or after raw offset `raw`. */
function collapsedIndexOf(c: Collapsed, raw: number): number {
  let lo = 0;
  let hi = c.toRaw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.toRaw[mid]! < raw) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The anchor for `raw.slice(start, end)`, or null when that is only whitespace. */
export function createAnchor(raw: string, start: number, end: number): TextAnchor | null {
  const c = collapse(raw);
  let from = collapsedIndexOf(c, start);
  let to = collapsedIndexOf(c, end);
  while (from < to && c.text[from] === ' ') from++;
  while (to > from && c.text[to - 1] === ' ') to--;
  if (to <= from) return null;
  return {
    exact: c.text.slice(from, to),
    prefix: c.text.slice(Math.max(0, from - CONTEXT), from),
    suffix: c.text.slice(to, to + CONTEXT),
    start: from,
  };
}

/** Where the anchored passage is in `raw` now, as raw offsets — or null if it is gone. */
export function findAnchor(raw: string, anchor: TextAnchor): { start: number; end: number } | null {
  const c = collapse(raw);
  const hit = bestMatch(c.text, anchor, false) ?? bestMatch(c.text.toLowerCase(), lowerAnchor(anchor), true);
  if (hit == null) return null;
  const last = hit + anchor.exact.length - 1;
  return { start: c.toRaw[hit]!, end: c.toRaw[last]! + 1 };
}

function lowerAnchor(a: TextAnchor): TextAnchor {
  return { ...a, exact: a.exact.toLowerCase(), prefix: a.prefix.toLowerCase(), suffix: a.suffix.toLowerCase() };
}

const MAX_CANDIDATES = 500;

function bestMatch(text: string, anchor: TextAnchor, _caseFolded: boolean): number | null {
  if (!anchor.exact) return null;
  let best: number | null = null;
  let bestScore = -Infinity;
  let seen = 0;
  for (let at = text.indexOf(anchor.exact); at >= 0 && seen < MAX_CANDIDATES; at = text.indexOf(anchor.exact, at + 1)) {
    seen++;
    const before = text.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = text.slice(at + anchor.exact.length, at + anchor.exact.length + anchor.suffix.length);
    const context = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    // Context decides; distance from the old position only breaks ties.
    const score = context - Math.abs(at - anchor.start) / Math.max(1, text.length);
    if (score > bestScore) {
      bestScore = score;
      best = at;
    }
  }
  return best;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/**
 * A text-fragment link (`#:~:text=`) to the passage: Chromium and Firefox scroll to and mark it
 * themselves, which is how a note opens at its place even where Aloud has no permission to run.
 */
export function textFragmentUrl(url: string, anchor: TextAnchor): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C');
  const words = anchor.exact.split(' ');
  // Long passages use the start,end form, which stays short and still matches the whole range.
  const text =
    words.length > 10
      ? `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}`
      : enc(anchor.exact);
  // Context is only usable when nothing but whitespace separates it from the passage: Chromium
  // rejects "expression,-you turn…" (prefix ending in a comma) and then scrolls nowhere at all.
  // Without it the link still finds the first occurrence, which is almost always the one.
  const before = anchor.prefix.replace(/\s+$/, '');
  const after = anchor.suffix.replace(/^\s+/, '');
  const touchesBefore = anchor.prefix !== before || before === '';
  const touchesAfter = anchor.suffix !== after || after === '';
  const prefix =
    touchesBefore && /[\p{L}\p{N}]$/u.test(before) ? before.split(' ').slice(-3).join(' ') : '';
  const suffix = touchesAfter && /^[\p{L}\p{N}]/u.test(after) ? after.split(' ').slice(0, 3).join(' ') : '';
  const parts = [prefix ? `${enc(prefix)}-` : '', text, suffix ? `-${enc(suffix)}` : ''];
  const base = url.split('#')[0]!;
  return `${base}#:~:text=${parts[0]}${parts[1]}${parts[2] ? `,${parts[2]}` : ''}`;
}
