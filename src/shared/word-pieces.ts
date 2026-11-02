/**
 * The words of a text, for timing them and lighting them up.
 *
 * Most languages put spaces between words, and a run of non-spaces is a word. Chinese, Japanese,
 * Thai, Lao, Khmer and Burmese do not: a whole Chinese sentence is one run, and was lit up as one
 * "word". Runs in those scripts are split again by the browser's own word segmenter
 * (`Intl.Segmenter`); punctuation stays with the word before it, as it does after a space.
 *
 * Word timing (engine/g2p/word-timing.ts) and the page highlight (highlight/word-map.ts) both
 * split with this, so their words always line up.
 */

/** Scripts written without spaces between words. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export interface WordPiece {
  /** Offset in the text. */
  at: number;
  token: string;
}

let segmenter: Intl.Segmenter | null | undefined;

function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  }
  return segmenter;
}

export function wordPieces(text: string): WordPiece[] {
  const out: WordPiece[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0];
    const at = m.index ?? 0;
    const seg = NO_SPACES.test(token) ? wordSegmenter() : null;
    if (!seg) {
      out.push({ at, token });
      continue;
    }
    let current: WordPiece | null = null;
    for (const s of seg.segment(token)) {
      if (s.isWordLike || !current) {
        current = { at: at + s.index, token: s.segment };
        out.push(current);
      } else {
        current.token += s.segment; // "，" or "。" after a word
      }
    }
  }
  return out;
}
