/**
 * Sentence segmentation.
 *
 * Uses `Intl.Segmenter` (Firefox 125+, Chromium 87+) for locale-aware sentence breaking, then:
 *   - hides reference markers ("[3]") from the segmenter, which otherwise breaks *inside* them,
 *   - treats a newline that merely wraps the markup as a space rather than a sentence end,
 *   - re-joins fragments left dangling after an abbreviation that Intl split on,
 *   - groups sentences that are one utterance when spoken — a reply and its attribution, a run of
 *     short exclamations — so the voice says them in one breath (see `groupUtterances`),
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
  /**
   * Plan utterances, not just sentences: a very short sentence is said with its neighbour
   * ("Yes. No. Maybe."). What the reader synthesises; sentence-level callers leave it off.
   */
  utterances?: boolean;
}

const DEFAULTS: Required<SegmentOptions> = {
  locale: 'en',
  maxChars: 240,
  minChars: 2,
  utterances: false,
};

// A trailing token like these means Intl probably broke mid-sentence: a lone initial ("J.")
// or a known abbreviation that is not itself sentence-final.
// Titles in the other languages Aloud reads ("Il Sig. Rossi", "La Sra. García", "Mme. Dupont"), and
// a single letter of either case — German writes "z. B." and "d. h." with a space inside.
const DANGLING_ABBR =
  /(?:^|\s)(?:[A-Za-z]|e\.g|i\.e|etc|vs|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Mt|Ft|No|Fig|al|Inc|Ltd|Co|Corp|Rev|Gen|Sen|Rep|Gov|Col|Sgt|Lt|Capt|Sept?|Oct|Nov|Dec|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sig|Sigg|Sig\.ra|Dott|Avv|Ing|Mons|Mme|Mlle|Mgr|Hr|Hrn|Fr|Frl|Sra|Srta|Sres|Dña|Ud|Uds|Sto|Sta|Nr|bzw|vgl|usw|ca)\.$/;

/**
 * Wikipedia-style reference markers: "[3]", "[34]", "[a]", "[3, 4]".
 *
 * `Intl.Segmenter` handles these appallingly badly. Given "…cancellation.[3] If a significant…"
 * it does not break after the full stop; it breaks *between* "[" and "3]", so one sentence ends
 * mid-marker and the next begins with "3] If a significant…". Every sentence boundary in a cited
 * paragraph is then wrong, the merge pass below glues the misaligned pieces back into one
 * paragraph-sized blob, and the clause splitter chops that blob at commas — which is heard as
 * the reader stopping in the middle of sentences for no reason.
 *
 * So the segmenter is shown a copy with every marker blanked to spaces. Blanking rather than
 * deleting keeps every offset identical, which matters because these offsets are what locate the
 * sentence in the live DOM. The marker itself stays in the chunk text, spoken as before.
 */
const REFERENCE_MARKER = /\[(?:\d{1,4}[a-z]?|[a-z])(?:\s*[,;–—-]\s*(?:\d{1,4}[a-z]?|[a-z]))*\]/gi;

function hideReferenceMarkers(text: string): string {
  return text.replace(REFERENCE_MARKER, (m) => ' '.repeat(m.length));
}

/**
 * Newlines that only wrap the source, hidden from the segmenter the same way.
 *
 * `buildTextIndex` copies text nodes verbatim, so the newlines and indentation an author used to
 * wrap their HTML end up in the text we segment — and `Intl.Segmenter` treats a line feed as a
 * *mandatory* sentence break (UAX #29, rule SB4). A paragraph written across three lines was
 * therefore read as three sentences, stopping dead in the middle of each one: "…runs entirely on
 * your" [pause] "own computer, and it follows along…". Since most HTML is wrapped, this affected
 * most pages.
 *
 * Inside one block every newline is formatting — real block boundaries are segmented separately
 * (see content/playlist.ts) — so the only one that still means anything is a blank line, which is
 * left alone. Blanked to a space rather than removed, so every offset still indexes into `text`.
 */
function softenWrapNewlines(text: string): string {
  // CR and U+2028 (LINE SEPARATOR) end a sentence under the same rule, so they get the same
  // treatment. U+2029 (PARAGRAPH SEPARATOR) is deliberately absent: it means what it says.
  return text.replace(/[\n\r\u2028]/g, (m, at: number, whole: string) =>
    isBlankLine(whole, at) ? m : ' ',
  );
}

const NEWLINE = /[\n\r\u2028]/;
/**
 * A line break that survived softening, and so is a real boundary: a blank line, or an explicit
 * PARAGRAPH SEPARATOR. Two fragments either side of one belong to different paragraphs and must
 * not be merged, however unfinished the first one looks.
 */
const HARD_BREAK = /[\n\r\u2028\u2029]/;
/** Anything whitespace-ish that is not itself a line break. */
const HORIZONTAL_SPACE = /[^\S\n\r\u2028]/;

/** Is the break at `at` part of a blank line — i.e. a paragraph separator rather than a wrap? */
function isBlankLine(text: string, at: number): boolean {
  let before = at - 1;
  while (before >= 0 && HORIZONTAL_SPACE.test(text[before] as string)) before--;
  // "\r\n" is one break, not a blank line: step over the CR of a CRLF pair before deciding.
  if (before >= 0 && text[before] === '\r' && text[at] === '\n') before--;
  while (before >= 0 && HORIZONTAL_SPACE.test(text[before] as string)) before--;
  if (before >= 0 && NEWLINE.test(text[before] as string)) return true;

  let after = at + 1;
  if (text[at] === '\r' && text[after] === '\n') after++;
  while (after < text.length && HORIZONTAL_SPACE.test(text[after] as string)) after++;
  return after < text.length && NEWLINE.test(text[after] as string);
}

/**
 * Does this fragment end a sentence?
 *
 * Trailing reference markers and closing quotes are not text as far as this question goes:
 * "…in jeopardy.[3]" is a finished sentence, and treating it as unfinished is what made the
 * merge pass swallow the sentence after it.
 */
const TRAILING_NON_TEXT = /(?:\s*(?:\[(?:\d{1,4}[a-z]?|[a-z])(?:\s*[,;–—-]\s*(?:\d{1,4}[a-z]?|[a-z]))*\]|["'”’)\]]))+$/i;

function endsSentence(text: string): boolean {
  return /[.!?…]$/.test(text.trimEnd().replace(TRAILING_NON_TEXT, ''));
}

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

/** Short direct speech is one utterance, even when it contains several exclamations. */
function quotedReplies(text: string, maxChars: number): Array<{ start: number; end: number }> {
  const replies: Array<{ start: number; end: number }> = [];
  const intro = /:\s*(["“«])/g;
  for (let match; (match = intro.exec(text));) {
    const start = intro.lastIndex - 1;
    const closer = match[1] === '“' ? '”' : match[1] === '«' ? '»' : '"';
    const closing = text.indexOf(closer, start + 1);
    if (closing < 0) continue;
    const end = closing + 1;
    // Long quotations retain ordinary sentence boundaries and their synthesis latency limit.
    // An inline quoted term (Define: "word" ...) is not a spoken reply.
    if (end - start > maxChars || HARD_BREAK.test(text.slice(match.index, end)) ||
        !/[.!?…]\s*$/.test(text.slice(start + 1, closing))) continue;
    replies.push({ start, end });
    intro.lastIndex = end;
  }
  return replies;
}

/**
 * How far a chunk may run past `maxChars` rather than be cut at an arbitrary word.
 *
 * `maxChars` is a latency knob, not a correctness one: it bounds how long the first sentence
 * takes to synthesise and how much has to be redone after a seek. Cutting a sentence at a space
 * to honour it — "…to renew their | subscription is a challenge…" — is plainly audible and is
 * the thing people notice and dislike. Overrunning the budget is not. So a span with no clause
 * boundary to break on is left whole unless it is genuinely runaway (no punctuation at all for
 * hundreds of characters), where an unbounded chunk would stall the start of playback.
 */
const OVERFLOW_TOLERANCE = 2;

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
    // The tail gets the same treatment as every other piece. Without this, a sentence whose only
    // comma sits near its start ("While recurring revenues can help the business and attract
    // investors, <150 more characters>") produced one piece covering the whole sentence, which
    // counted as "no progress", fell through to the hard wrap, and was cut mid-clause.
    if (end - pieceStart > maxChars && lastCut > pieceStart) {
      pieces.push([pieceStart, lastCut]);
      pieceStart = lastCut;
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

  // No usable clause boundary. Keep it whole unless it is runaway — see OVERFLOW_TOLERANCE.
  if (end - start <= maxChars * OVERFLOW_TOLERANCE) return [[start, end]];

  // Runaway span: hard-wrap on the nearest space.
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

/** Closing quotes that cannot open anything: a span starting with one has been cut too early. */
const LEADING_CLOSER = /^[»”’]+/;

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** A sentence this short (in words) is said with its neighbour: "No!", "Yes.", "Well…". */
const SHORT_UTTERANCE_WORDS = 2;

/**
 * Join sentences that are one utterance when spoken, within one paragraph and never past
 * `maxChars` (the latency bound). Each group is a contiguous slice of `text`, so it is located,
 * highlighted and sought exactly as a sentence is — the word highlight still steps through it.
 *
 *  - A closing quote cut off at the start of a span goes back to the sentence it closes: French
 *    puts a space before "!" and "»", and `Intl.Segmenter` broke "« Non ! » dit le poulet." into
 *    "« Non !" and "» dit le poulet.".
 *  - A span starting with a lowercase letter continues the one before: the attribution after a
 *    reply ("No!" | he said.), never a sentence of its own. Scripts without case never match.
 *  - With `utterances`: a very short sentence is said with its neighbour ("Yes. No. Maybe.",
 *    "Well... I don't know."), rather than as a request of its own with a pause either side.
 *
 * Nothing is joined across a blank line, and the narration before a colon-introduced reply stays
 * apart from it unless it is itself a short attribution ("He said: «No!»").
 */
function groupUtterances(
  text: string,
  forBreaking: string,
  spans: Array<{ start: number; end: number; reply?: boolean }>,
  maxChars: number,
  joinShort: boolean,
): Array<{ start: number; end: number; reply?: boolean }> {
  const out: Array<{ start: number; end: number; reply?: boolean }> = [];
  for (const span of spans) {
    let cur = { ...span };
    const prev = out[out.length - 1];
    if (prev && !HARD_BREAK.test(forBreaking.slice(prev.end, cur.start))) {
      const closer = LEADING_CLOSER.exec(text.slice(cur.start, cur.end));
      if (closer) {
        prev.end = cur.start + closer[0].length;
        cur = { ...cur, ...trimmedSpan(text, cur.start + closer[0].length, cur.end) };
        if (cur.end <= cur.start) continue;
      }
      const prevText = text.slice(prev.start, prev.end);
      const curText = text.slice(cur.start, cur.end);
      const fits = cur.end - prev.start <= maxChars;
      const continues = /^[\s"'“”«»„‚‘’\-–—(]*\p{Ll}/u.test(curText);
      const short = joinShort && (wordCount(prevText) <= SHORT_UTTERANCE_WORDS || wordCount(curText) <= SHORT_UTTERANCE_WORDS);
      if (fits && (continues || short)) {
        prev.end = cur.end;
        prev.reply = prev.reply || cur.reply;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

export function segmentSentences(text: string, options: SegmentOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const raw: Array<{ start: number; end: number; reply?: boolean }> = [];

  // Same length as `text`, so every offset below is an offset into `text` itself.
  const forBreaking = softenWrapNewlines(hideReferenceMarkers(text));

  const HasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  const seg = HasSegmenter ? new Intl.Segmenter(opts.locale, { granularity: 'sentence' }) : null;
  const split = (start: number, end: number): void => {
    const slice = forBreaking.slice(start, end);
    if (seg) {
      for (const s of seg.segment(slice)) {
        raw.push({ start: start + s.index, end: start + s.index + s.segment.length });
      }
    } else {
      // Minimal fallback: split on sentence-final punctuation followed by whitespace + capital.
      const re = /[^.!?…]+[.!?…]+(?:["'”’)\]]+)?\s+|[^.!?…]+$/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(slice))) raw.push({ start: start + m.index, end: start + m.index + m[0].length });
    }
  };
  let start = 0;
  for (const reply of quotedReplies(forBreaking, opts.maxChars)) {
    split(start, reply.start);
    raw.push({ ...reply, reply: true });
    start = reply.end;
  }
  split(start, forBreaking.length);

  // Merge dangling-abbreviation fragments and sub-min fragments.
  const merged: typeof raw = [];
  for (const cur of raw) {
    const span = trimmedSpan(text, cur.start, cur.end);
    if (span.end <= span.start) continue;
    const prev = merged[merged.length - 1];
    const prevText = prev ? text.slice(prev.start, prev.end) : '';
    if (
      prev &&
      !prev.reply && !cur.reply &&
      (DANGLING_ABBR.test(prevText.trimEnd()) ||
        span.end - span.start < opts.minChars ||
        !endsSentence(prevText))
    ) {
      // Only merge across a missing terminator within one paragraph. Read from `forBreaking`, so
      // a newline that merely wraps the source does not count as the paragraph ending.
      const between = forBreaking.slice(prev.end, span.start);
      if (!HARD_BREAK.test(between) || DANGLING_ABBR.test(prevText.trimEnd())) {
        prev.end = span.end;
        continue;
      }
    }
    merged.push({ ...span, reply: cur.reply });
  }

  // Clause-split long chunks, then materialise.
  const chunks: Chunk[] = [];
  for (const { start, end } of groupUtterances(text, forBreaking, merged, opts.maxChars, opts.utterances)) {
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
