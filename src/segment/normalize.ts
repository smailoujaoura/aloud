/**
 * Text normalisation for TTS.
 *
 * This runs *per chunk*, only on the text handed to the synthesiser. The original chunk text is
 * kept untouched for DOM highlighting, so nothing here needs to preserve character offsets.
 *
 * eSpeak-NG (used by both the Piper and Kokoro G2P paths) already expands cardinals, decimals,
 * years, currency, percentages and ordinals well. The job here is the things it does badly:
 *   - reading raw URLs / e-mail addresses character by character,
 *   - abbreviations that also trip sentence segmentation ("e.g.", "Dr."),
 *   - stray symbols and emoji,
 *   - runs of punctuation that make the prosody stutter.
 */

const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
  [/\betc\./gi, 'et cetera'],
  // Only the lowercase word: "VS Code", "VS" in a product name, is not "versus".
  [/\bvs\.(?=\s)|\bvs(?=\s+\S)/g, 'versus'],
  [/\bcf\./gi, 'compare'],
  [/\bapprox\./gi, 'approximately'],
  [/\best\.\s/gi, 'estimated '],
  [/\bDr\./g, 'Doctor'],
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bMs\./g, 'Miss'],
  [/\bProf\./g, 'Professor'],
  [/\bSt\.\s/g, 'Saint '],
  [/\bMt\.\s/g, 'Mount '],
  [/\bNo\.\s?(\d)/g, 'number $1'],
  [/\bFig\.\s?(\d)/gi, 'figure $1'],
  [/\bpp?\.\s?(\d)/g, 'page $1'],
  [/\bvol\.\s?(\d)/gi, 'volume $1'],
  [/\ba\.m\./gi, 'A M'],
  [/\bp\.m\./gi, 'P M'],
  [/\bU\.S\.A\./g, 'U S A'],
  [/\bU\.S\./g, 'U S'],
  [/\bU\.K\./g, 'U K'],
  [/\bE\.U\./g, 'E U'],
];

const SYMBOL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, ' and '],
  [/\s@\s/g, ' at '],
  [/\+\/-|±/g, ' plus or minus '],
  [/(?<=\w)\s*\/\s*(?=\w)/g, ' slash '], // a/b -> "a slash b" (only between word chars)
  // Numeric ranges: an en dash always ("5–10" -> "5 to 10"); a hyphen only between two plain
  // numbers (`rangeWithHyphen`), never in a phone number, a date, a time or a code.
  [/(?<=\d)\s*–\s*(?=\d)/g, ' to '],
  [/×/g, ' times '],
  [/°/g, ' degrees '],
  [/…/g, '… '],
];

// Emoji / pictographs / symbol blocks that should simply be dropped.
const PICTOGRAPHIC =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}‍]/gu;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

/**
 * "5-10" -> "5 to 10", but not "555-1234" (a phone number), "2024-10-05" (a date), "9-05" (a
 * time, or anything with a leading zero) or "1-2-3" (a code): a hyphen between numbers is a range
 * only when it joins exactly two short numbers, neither starting with 0, with nothing more
 * hyphenated on either side.
 */
function rangeWithHyphen(text: string): string {
  return text.replace(/(?<![\d.,\-–])(\d{1,4})\s?-\s?(\d{1,4})(?![\d.,]?\d|\s?-\s?\d)/g, (whole, a: string, b: string) => {
    if (/^0\d/.test(a) || /^0/.test(b)) return whole;
    if (a.length === 3 && b.length === 4) return whole; // 555-1234
    return `${a} to ${b}`;
  });
}

export interface NormalizeOptions {
  /**
   * The language of the voice reading (BCP 47, e.g. "de-DE"). The word expansions here are
   * English: for any other language they are skipped, and eSpeak says the symbols in that
   * language's own words. (A German voice read "Müller & Söhne" as "Müller and Söhne".)
   */
  language?: string;
  /**
   * What to say in place of a URL. Empty string drops it entirely; `null` leaves the address in
   * the text to be read out as it stands.
   */
  urlReplacement?: string | null;
  /** What to say in place of an e-mail address. */
  emailReplacement?: string;
  /** Expand common abbreviations. */
  expandAbbreviations?: boolean;
}

const DEFAULTS: {
  language: string;
  urlReplacement: string | null;
  emailReplacement: string;
  expandAbbreviations: boolean;
} = {
  language: 'en',
  urlReplacement: 'link',
  emailReplacement: 'e-mail address',
  expandAbbreviations: true,
};

export function normalizeForSpeech(input: string, options: NormalizeOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  // Strip glyphs that NFKC would otherwise expand into letters ("™" -> "TM").
  let text = input.replace(/[™®©℠]/g, '').normalize('NFKC');

  const english = /^en\b/i.test(opts.language);
  // The stand-in words are English: in another language an address is simply left out.
  if (opts.urlReplacement != null) text = text.replace(URL_RE, english ? ` ${opts.urlReplacement} ` : ' ');
  text = text.replace(EMAIL_RE, english ? ` ${opts.emailReplacement} ` : ' ');

  if (english) {
    if (opts.expandAbbreviations) {
      for (const [re, repl] of ABBREVIATIONS) text = text.replace(re, repl);
    }
    for (const [re, repl] of SYMBOL_WORDS) text = text.replace(re, repl);
    text = rangeWithHyphen(text);
  }

  text = text.replace(PICTOGRAPHIC, ' ');

  // Soft hyphen, zero-width, and other invisibles.
  text = text.replace(/[­​‌﻿]/g, '');

  // Collapse any run of the same sentence-final punctuation ("!!!" -> "!").
  text = text.replace(/([!?.])\1{1,}/g, '$1');

  // Bullet / list glyphs at the start of a chunk.
  text = text.replace(/^\s*[•◦‣⁃∙*\-–—]\s+/, '');

  // Collapse whitespace (including the newlines the text index inserts between blocks).
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * True when a chunk carries no speakable content after normalisation (pure punctuation,
 * separators, leftover symbols). Such chunks are skipped by the scheduler but still consume a
 * highlight slot so indices stay aligned.
 */
export function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
