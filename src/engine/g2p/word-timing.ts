/**
 * When each written word is spoken, from the voice model's own phoneme durations.
 *
 * A VITS voice decides how many audio frames every phoneme gets before it makes any sound, so
 * the time each phoneme starts is known exactly (see `onnx-outputs.ts` for how that is read out
 * of a Piper model). What is not known is which *written word* each phoneme belongs to: eSpeak
 * runs short words together ("in the" → `ɪnðə`), and expands others into several ("1990" →
 * `nˈaɪntiːnhˈʌndɹɪdən nˈaɪntɪ`), so counting spaces lands on the wrong word within a sentence.
 *
 * So each word is also phonemised on its own, and the two phoneme strings are aligned sound by
 * sound (Needleman–Wunsch). Every sound in the sentence then belongs to exactly one word, and a
 * word is spoken from its first sound's start to its last sound's end. Words phonemised in
 * isolation sound slightly different from the same words in a sentence — weak forms, linking —
 * which is why the alignment compares folded vowel classes rather than exact symbols.
 */

export interface TextWord {
  /** Where the word is highlighted: the token without surrounding punctuation. */
  from: number;
  to: number;
  /** What is phonemised for it: the whole token, so "$3.50" still says "dollars". */
  token: string;
}

/** A sound in the spoken sentence, and when it plays, in seconds from the start of the audio. */
export interface TimedSound {
  sym: string;
  start: number;
  end: number;
}

/** Whitespace-separated tokens, each with the span to highlight. */
export function splitWords(text: string): TextWord[] {
  const words: TextWord[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0];
    const at = m.index ?? 0;
    const lead = token.search(/[\p{L}\p{N}]/u);
    if (lead < 0) {
      // "—", "…", "&": nothing to highlight on its own, but "&" is still said, so keep it and let
      // alignment decide whether any sound belongs to it.
      words.push({ from: at, to: at + token.length, token });
      continue;
    }
    let tail = token.length;
    // Marks belong to the letter before them: a Hindi word ends in a vowel sign ("नमस्ते" in "े"),
    // Arabic in a vowel mark. Trimmed as punctuation, the highlight stopped a sound short.
    while (tail > lead && !/[\p{L}\p{N}\p{M}]/u.test(token[tail - 1]!)) tail--;
    words.push({ from: at + lead, to: at + tail, token });
  }
  return words;
}

/** Stress marks, length marks, tie bars, spaces and punctuation: not sounds of their own. */
const NOT_A_SOUND = /[\sˈˌːˑ‿͡.,;:!?¡¿…"'“”‘’()[\]{}«»—–\-/]/u;

/** The sounds of an IPA string, one entry per code point that is a sound. */
export function soundsOf(ipa: string | readonly string[]): string[] {
  const chars = typeof ipa === 'string' ? [...ipa] : ipa.flatMap((p) => [...p]);
  return chars.filter((c) => !NOT_A_SOUND.test(c));
}

/**
 * Sounds that eSpeak swaps between a word said alone and the same word in running speech: vowel
 * reductions (`tuː` → `tə`), British/American variants, flapping. Folding them makes those count
 * as matches instead of gaps, which is what keeps short function words aligned.
 */
const FOLD: Record<string, string> = {
  ɐ: 'ə', ɜ: 'ə', ɚ: 'ə', ɝ: 'ə', ᵻ: 'ɪ', i: 'ɪ', ɨ: 'ɪ', ʊ: 'u', ɵ: 'u', ʉ: 'u',
  ɒ: 'o', ɔ: 'o', ɑ: 'a', æ: 'a', ʌ: 'a', ɛ: 'e', ɾ: 't', ɹ: 'r', ʁ: 'r', ɻ: 'r',
};
const fold = (s: string): string => FOLD[s] ?? s;

/**
 * For each spoken sound, the index of the word it belongs to.
 *
 * Global alignment of the sentence's sounds against the words' sounds laid end to end. A sound
 * the alignment leaves unpaired (eSpeak inserted it in context) goes to the word before it, or to
 * the first word if nothing precedes it.
 */
export function ownersOf(spoken: readonly string[], words: readonly (readonly string[])[]): number[] {
  const target: string[] = [];
  const wordOf: number[] = [];
  words.forEach((sounds, w) => {
    for (const s of sounds) {
      target.push(fold(s));
      wordOf.push(w);
    }
  });
  const a = spoken.map(fold);
  const n = a.length;
  const m = target.length;
  const owners = new Array<number>(n).fill(-1);
  if (n === 0 || m === 0) return owners;

  const MATCH = 2;
  const MISMATCH = -1;
  const GAP = -1;
  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  // 0 = diagonal, 1 = up (spoken sound unpaired), 2 = left (word sound unpaired)
  const move = new Uint8Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    score[i * width] = i * GAP;
    move[i * width] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    move[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * width + j - 1]! + (a[i - 1] === target[j - 1] ? MATCH : MISMATCH);
      const up = score[(i - 1) * width + j]! + GAP;
      const left = score[i * width + j - 1]! + GAP;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      score[i * width + j] = best;
      move[i * width + j] = dir;
    }
  }

  for (let i = n, j = m; i > 0 || j > 0; ) {
    const dir = i === 0 ? 2 : j === 0 ? 1 : move[i * width + j]!;
    if (dir === 0) {
      owners[i - 1] = wordOf[j - 1]!;
      i--;
      j--;
    } else if (dir === 1) {
      i--;
    } else {
      j--;
    }
  }

  let last = -1;
  for (let i = 0; i < n; i++) {
    if (owners[i]! >= 0) last = owners[i]!;
    else owners[i] = last;
  }
  const first = owners.find((o) => o >= 0) ?? -1;
  for (let i = 0; i < n && owners[i]! < 0; i++) owners[i] = first;
  return owners;
}

/**
 * Start and end of every word, or null for a word no sound was assigned to (punctuation, or a
 * word eSpeak dropped). Times never go backwards from one word to the next.
 */
export function wordTimes(spoken: readonly TimedSound[], words: readonly (readonly string[])[]): Array<{ start: number; end: number } | null> {
  const owners = ownersOf(
    spoken.map((s) => s.sym),
    words,
  );
  const times: Array<{ start: number; end: number } | null> = words.map(() => null);
  owners.forEach((w, i) => {
    if (w < 0) return;
    const sound = spoken[i]!;
    const t = times[w];
    if (t) {
      t.start = Math.min(t.start, sound.start);
      t.end = Math.max(t.end, sound.end);
    } else {
      times[w] = { start: sound.start, end: sound.end };
    }
  });
  let floor = 0;
  for (const t of times) {
    if (!t) continue;
    t.start = Math.max(t.start, floor);
    t.end = Math.max(t.end, t.start);
    floor = t.start;
  }
  return times;
}
