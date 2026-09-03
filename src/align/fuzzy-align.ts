/**
 * Locate each sentence (segmented from the clean Readability text) inside the live DOM's
 * `fullText`, returning `[start, end)` offsets that `rangeForSpan` can turn into a highlight.
 *
 * The two text sources differ in whitespace, punctuation, entity handling and the odd
 * re-ordered node, so matching is done on a *canonical* form (lowercase, alphanumerics only,
 * collapsed) with a monotonic cursor and a bigram-similarity fallback.
 */

export interface Located {
  chunkIndex: number;
  start: number;
  end: number;
  confidence: number;
}

interface Canon {
  /** Canonical string: lowercase [\p{L}\p{N}] runs separated by single spaces. */
  text: string;
  /** map[i] = index in the source string of canonical char i. */
  map: number[];
}

const ALNUM = /[\p{L}\p{N}]/u;

export function canonicalize(src: string): Canon {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ALNUM.test(ch)) {
      if (pendingSpace && chars.length > 0) {
        chars.push(' ');
        map.push(i);
      }
      pendingSpace = false;
      chars.push(ch.toLowerCase());
      map.push(i);
    } else {
      pendingSpace = true;
    }
  }
  return { text: chars.join(''), map };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character bigrams. 1 = identical. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [, n] of A) total += n;
  for (const [, n] of B) total += n;
  for (const [g, n] of A) {
    const bn = B.get(g);
    if (bn) overlap += Math.min(n, bn);
  }
  return (2 * overlap) / total;
}

export interface AlignerOptions {
  /** Minimum Dice similarity for a fuzzy (non-exact) match to be accepted. */
  minConfidence?: number;
}

/**
 * Stateful forward aligner. Feed it chunks in document order; it keeps a cursor so repeated
 * phrases resolve to the right occurrence.
 */
export class Aligner {
  private readonly hay: Canon;
  private readonly haySourceLen: number;
  private cursor = 0;
  private readonly minConfidence: number;

  constructor(fullText: string, options: AlignerOptions = {}) {
    this.hay = canonicalize(fullText);
    this.haySourceLen = fullText.length;
    this.minConfidence = options.minConfidence ?? 0.62;
  }

  locate(chunkText: string, chunkIndex: number): Located | null {
    const needle = canonicalize(chunkText).text;
    if (needle.length < 2) return null;

    // 1. Exact canonical match at/after the cursor.
    let ci = this.hay.text.indexOf(needle, this.cursor);
    if (ci === -1 && this.cursor > 0) {
      // Maybe slightly behind the cursor (overlapping split); look a little back.
      ci = this.hay.text.indexOf(needle, Math.max(0, this.cursor - needle.length));
    }
    if (ci !== -1) {
      return this.accept(ci, ci + needle.length, chunkIndex, 1);
    }

    // 2. Anchor on a distinctive prefix, then extend by needle length.
    const anchorLen = Math.min(needle.length, Math.max(16, Math.floor(needle.length * 0.4)));
    const anchor = needle.slice(0, anchorLen);
    let ai = this.hay.text.indexOf(anchor, this.cursor);
    if (ai === -1) ai = this.hay.text.indexOf(anchor, Math.max(0, this.cursor - anchorLen));
    if (ai !== -1) {
      const windowEnd = Math.min(this.hay.text.length, ai + needle.length + 8);
      const candidate = this.hay.text.slice(ai, windowEnd);
      const conf = diceSimilarity(needle, candidate);
      if (conf >= this.minConfidence) {
        // Trim the candidate window to the needle's length for a tighter range.
        return this.accept(ai, Math.min(ai + needle.length, this.hay.text.length), chunkIndex, conf);
      }
    }

    // 3. Global search (handles the rare re-ordered node) — accept only on a strong match.
    const gi = this.hay.text.indexOf(needle);
    if (gi !== -1) return this.accept(gi, gi + needle.length, chunkIndex, 0.9);

    return null;
  }

  private accept(canonStart: number, canonEnd: number, chunkIndex: number, confidence: number): Located {
    const clampedEnd = Math.min(canonEnd, this.hay.map.length);
    const start = this.hay.map[canonStart] ?? 0;
    const end =
      clampedEnd > canonStart
        ? (this.hay.map[clampedEnd - 1] ?? this.haySourceLen - 1) + 1
        : start + 1;
    this.cursor = Math.max(this.cursor, clampedEnd);
    return { chunkIndex, start, end: Math.min(end, this.haySourceLen), confidence };
  }
}
