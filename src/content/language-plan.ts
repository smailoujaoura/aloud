/**
 * Which language each passage of a page is in.
 *
 * A page is not one language. The bilingual story that started this alternates Italian and
 * English paragraphs; a news article quotes a sentence of French; a dictionary page is every
 * language at once. Reading all of it with one voice pronounces most of it wrong.
 *
 * A passage is a block of the page (a paragraph, a heading, a list item). Its language comes from,
 * in order of trust:
 *
 *  1. A `lang` attribute on the passage or an element around it, below `<html>`/`<body>`. A local
 *     annotation is deliberate; the page-wide one is often a CMS template's (`lang="en"` on pages
 *     in every language) and only serves as a last resort.
 *  2. The browser's own detector (`i18n.detectLanguage`, CLD), when it says the result is reliable
 *     and the passage has enough letters to judge. Its `percentage` is the share of the input in
 *     that language, not a confidence, so it is not used as one.
 *  3. A writing system only one supported language uses (Hangul, kana, Greek, …).
 *  4. Context: the language of the passages around it. A one-word reply ("No!"), a name, or a
 *     heading too short to judge belongs to the conversation it is in — so does a short passage
 *     the detector calls something else while both of its neighbours agree on another. This is
 *     what keeps the voice from switching back and forth on every exclamation.
 *  5. The page's language, as the reader decided it for the whole page.
 *
 * Passages are never merged to get a longer sample: alternating translations would blur into
 * one language. Pure apart from the detector it is given, so the rules are testable.
 */
import { primaryLanguage } from '@/shared/language-voice';

export interface Detection {
  language: string;
  reliable: boolean;
}

/** The browser's detector, or a stand-in. Null when it cannot answer. */
export type Detector = (text: string) => Promise<Detection | null>;

export interface PassageInput {
  text: string;
  /** The nearest `lang` attribute below `<html>`/`<body>`, or ''. */
  markup: string;
}

export type LanguageSource = 'markup' | 'detected' | 'script' | 'context' | 'page';

export interface PassageLanguage {
  /** Primary language (`it`, `en`), or '' when nothing could tell. */
  language: string;
  source: LanguageSource;
}

/** Fewer letters than this, and the detector is not asked: it is a guess at that length. */
const MIN_LETTERS_TO_DETECT = 12;
/**
 * A passage this short (in words) whose neighbours agree takes their language: an exclamation,
 * a name. Words, not letters — "Let me tell you a story about a chicken." is short in letters but
 * is a sentence the detector can judge, and a short translation must keep its own language.
 */
const SHORT_PASSAGE_WORDS = 3;

/** Enough different words to be judged: a sentence, not an exclamation said three times. */
/**
 * Words as the text's own writing system has them. Splitting on spaces counted a whole Chinese
 * or Japanese paragraph as one word — "short" — so its English neighbours outvoted a reliable
 * detection. The segmenter knows where words end in scripts written without spaces.
 */
const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

function wordsOf(text: string): string[] {
  if (wordSegmenter) {
    const out: string[] = [];
    for (const s of wordSegmenter.segment(text.toLowerCase())) if (s.isWordLike) out.push(s.segment);
    return out;
  }
  return text.toLowerCase().match(/[\p{L}\p{M}']+/gu) ?? [];
}

function substantial(text: string): boolean {
  const words = wordsOf(text);
  return letterCount(text) >= 25 && words.length >= 5 && new Set(words).size >= 4;
}

function isShortPassage(text: string): boolean {
  return wordsOf(text).length <= SHORT_PASSAGE_WORDS || letterCount(text) < MIN_LETTERS_TO_DETECT;
}

export function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/**
 * The language a writing system belongs to, when only one supported language uses it.
 * Latin, Cyrillic, Arabic and Devanagari are shared by many and say nothing on their own.
 */
export function scriptLanguage(text: string): string {
  const counts: Array<[string, RegExp]> = [
    ['ko', /\p{Script=Hangul}/gu],
    ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
    ['el', /\p{Script=Greek}/gu],
    ['he', /\p{Script=Hebrew}/gu],
    ['th', /\p{Script=Thai}/gu],
    ['ka', /\p{Script=Georgian}/gu],
    ['hy', /\p{Script=Armenian}/gu],
  ];
  const letters = letterCount(text);
  if (!letters) return '';
  for (const [language, re] of counts) {
    if ((text.match(re)?.length ?? 0) >= letters * 0.3) return language;
  }
  // Han with no kana: Chinese. (Japanese text nearly always has kana, caught above.)
  if ((text.match(/\p{Script=Han}/gu)?.length ?? 0) >= letters * 0.5) return 'zh';
  return '';
}

/**
 * Decide each passage's language. `detect` is called at most once per distinct text (`cache`
 * keeps answers across calls, e.g. after a translation is revealed).
 */
export async function planLanguages(
  passages: readonly PassageInput[],
  detect: Detector,
  pageLanguage: string,
  cache: Map<string, Detection | null> = new Map(),
): Promise<PassageLanguage[]> {
  // Every distinct text that needs the detector, asked at once: one at a time, a long page
  // waited on hundreds of round trips before its first sentence.
  const ask = new Set<string>();
  for (const p of passages) {
    const key = p.text.trim();
    if (!primaryLanguage(p.markup) && letterCount(key) >= MIN_LETTERS_TO_DETECT && !cache.has(key)) ask.add(key);
  }
  await Promise.all(
    [...ask].map(async (key) => {
      cache.set(key, await detect(key).catch(() => null));
    }),
  );

  const out: Array<PassageLanguage | null> = [];
  for (const passage of passages) {
    const markup = primaryLanguage(passage.markup);
    if (markup) {
      out.push({ language: markup, source: 'markup' });
      continue;
    }
    const letters = letterCount(passage.text);
    let decided: PassageLanguage | null = null;
    if (letters >= MIN_LETTERS_TO_DETECT) {
      const found = cache.get(passage.text.trim());
      // CLD calls nearly every sentence under ~60 characters unreliable, yet for an ordinary
      // sentence it is right ("Let me tell you a story about a chicken." → en, not reliable).
      // Where it is wrong is a few repeated words: "No! No! Go away!" → pt, "Vattene!" → de.
      // So an unreliable answer counts for a real sentence and nothing shorter.
      const usable = found && (found.reliable || substantial(passage.text));
      if (usable && primaryLanguage(found.language) && found.language !== 'und') {
        decided = { language: primaryLanguage(found.language), source: 'detected' };
      }
    }
    if (!decided) {
      const script = scriptLanguage(passage.text);
      if (script) decided = { language: script, source: 'script' };
    }
    out.push(decided);
  }

  // A short passage between two that agree on another language is in theirs.
  const short = passages.map((p) => isShortPassage(p.text));
  const neighbour = (from: number, step: 1 | -1): PassageLanguage | null => {
    for (let i = from + step; i >= 0 && i < out.length; i += step) {
      const d = out[i];
      if (d && d.source !== 'context' && !short[i]) return d;
    }
    return null;
  };
  for (let i = 0; i < out.length; i++) {
    const d = out[i];
    if (!d || d.source === 'markup' || !short[i]) continue;
    const before = neighbour(i, -1);
    const after = neighbour(i, 1);
    if (before && after && before.language === after.language && before.language !== d.language) {
      out[i] = { language: before.language, source: 'context' };
    }
  }

  // Undecided: the passage before it (reading continues in the language it was in), else the
  // one after (a title before the first paragraph), else the page.
  const page = primaryLanguage(pageLanguage);
  const decided = out.map((d) => d);
  for (let i = 0; i < out.length; i++) {
    if (decided[i]) continue;
    let pick: PassageLanguage | null = null;
    for (let j = i - 1; j >= 0 && !pick; j--) if (decided[j]) pick = decided[j]!;
    for (let j = i + 1; j < out.length && !pick; j++) if (out[j]) pick = out[j]!;
    decided[i] = pick
      ? { language: pick.language, source: pick.source === 'page' ? 'page' : 'context' }
      : { language: page, source: 'page' };
  }
  return decided as PassageLanguage[];
}
