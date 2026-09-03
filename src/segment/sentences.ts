/**
 * Sentence segmentation.
 *
 * Uses `Intl.Segmenter` (Firefox 125+, Chromium 87+) for locale-aware sentence breaking, then:
 *   - re-joins fragments left dangling after an abbreviation that Intl split on,
 *   - splits sentences longer than `maxChars` at clause boundaries so that first-audio latency
 *     and re-synthesis after a seek stay bounded.
 *
 * Offsets in the returned chunks are relative to the `text` argument. Callers pass the exact
 * string they will later search the live DOM against, so these offsets round-trip.
 */

export interface Chunk {
  /** Raw sentence text, verbatim slice of the input. */
  text: string;
  /** Inclusive start offset into the input string. */
  start: number;
  /** Exclusive end offset into the input string. */
  end: number;
  /** Index in the returned array (stable id for the pipeline). */
  index: number;
}

export interface SegmentOptions {
  locale?: string;
  /** Hard upper bound on chunk length before clause splitting kicks in. */
  maxChars?: number;
  /** Chunks shorter than this are merged into the previous chunk. */
  minChars?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  locale: 'en',
  maxChars: 240,
  minChars: 2,
};

// A trailing token like these means Intl probably broke mid-sentence: a lone initial ("J.")
// or a known abbreviation that is not itself sentence-final.
const DANGLING_ABBR =
  /(?:^|\s)(?:[A-Z]|e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Mt|Ft|No|Fig|al|Inc|Ltd|Co|Corp|Rev|Gen|Sen|Rep|Gov|Col|Sgt|Lt|Capt|Sept?|Oct|Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug)\.$/;

// Clause split points, most-preferred first.
const CLAUSE_BREAKS: RegExp[] = [
  /;\s+/g,
  /:\s+/g,
  /\s—\s|\s–\s|\s-\s/g, // spaced em / en / hyphen dash
  /,\s+/g,
];

function trimmedSpan(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] as string)) s++;
  while (e > s && /\s/.test(text[e - 1] as string)) e--;
  return { start: s, end: e };
}

const MIN_PIECE = 16;

/** Split [start,end) of `text` into pieces no longer than maxChars, at clause boundaries. */
function clauseSplit(
  text: string,
  start: number,
  end: number,
  maxChars: number,
  breakIndex = 0,
): Array<[number, number]> {
  if (end - start <= maxChars) return [[start, end]];

  for (let bi = breakIndex; bi < CLAUSE_BREAKS.length; bi++) {
    const re = CLAUSE_BREAKS[bi]!;
    re.lastIndex = 0;
    const slice = text.slice(start, end);
    const cuts: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice))) {
      const cutAt = start + m.index + m[0].length;
      if (cutAt - start >= MIN_PIECE && end - cutAt >= MIN_PIECE) cuts.push(cutAt);
    }
    if (cuts.length === 0) continue;

    // Greedily accumulate cuts so each piece is <= maxChars where possible.
    const pieces: Array<[number, number]> = [];
    let pieceStart = start;
    let lastCut = start;
    for (const cut of cuts) {
      if (cut - pieceStart > maxChars && lastCut > pieceStart) {
        pieces.push([pieceStart, lastCut]);
        pieceStart = lastCut;
      }
      lastCut = cut;
    }
    pieces.push([pieceStart, end]);

    // If this break type made no progress, move on to a weaker one.
    if (pieces.length === 1) continue;

    const out: Array<[number, number]> = [];
    for (const [ps, pe] of pieces) {
      if (pe - ps > maxChars) out.push(...clauseSplit(text, ps, pe, maxChars, bi + 1));
      else out.push([ps, pe]);
    }
    return out;
  }

  // No usable clause boundary: hard-wrap on the nearest space.
  const out: Array<[number, number]> = [];
  let s = start;
  while (end - s > maxChars) {
    let cut = s + maxChars;
    while (cut > s + MIN_PIECE && !/\s/.test(text[cut] as string)) cut--;
    if (cut <= s + MIN_PIECE) cut = s + maxChars;
    out.push([s, cut]);
    s = cut;
  }
  out.push([s, end]);
  return out;
}

export function segmentSentences(text: string, options: SegmentOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const raw: Array<{ start: number; end: number }> = [];

  const HasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  if (HasSegmenter) {
    const seg = new Intl.Segmenter(opts.locale, { granularity: 'sentence' });
    for (const s of seg.segment(text)) {
      raw.push({ start: s.index, end: s.index + s.segment.length });
    }
  } else {
    // Minimal fallback: split on sentence-final punctuation followed by whitespace + capital.
    const re = /[^.!?…]+[.!?…]+(?:["'”’)\]]+)?\s+|[^.!?…]+$/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) raw.push({ start: m.index, end: m.index + m[0].length });
  }

  // Merge dangling-abbreviation fragments and sub-min fragments.
  const merged: Array<{ start: number; end: number }> = [];
  for (const cur of raw) {
    const span = trimmedSpan(text, cur.start, cur.end);
    if (span.end <= span.start) continue;
    const prev = merged[merged.length - 1];
    const prevText = prev ? text.slice(prev.start, prev.end) : '';
    if (
      prev &&
      (DANGLING_ABBR.test(prevText.trimEnd()) || span.end - span.start < opts.minChars || !/[.!?…]$/.test(prevText.trimEnd()))
    ) {
      // Only merge across a missing terminator if the two are close (same paragraph, no newline).
      const between = text.slice(prev.end, span.start);
      if (!between.includes('\n') || DANGLING_ABBR.test(prevText.trimEnd())) {
        prev.end = span.end;
        continue;
      }
    }
    merged.push({ start: span.start, end: span.end });
  }

  // Clause-split long chunks, then materialise.
  const chunks: Chunk[] = [];
  for (const { start, end } of merged) {
    for (const [ps, pe] of clauseSplit(text, start, end, opts.maxChars)) {
      const span = trimmedSpan(text, ps, pe);
      if (span.end <= span.start) continue;
      chunks.push({
        text: text.slice(span.start, span.end),
        start: span.start,
        end: span.end,
        index: chunks.length,
      });
    }
  }

  return chunks;
}
