import { describe, it, expect } from 'vitest';
import { ownersOf, soundsOf, splitWords, wordTimes, type TimedSound } from '@/engine/g2p/word-timing';

/** Sounds of an IPA sentence, each 0.1 s long, back to back. */
function timed(ipa: string): TimedSound[] {
  return soundsOf(ipa).map((sym, i) => ({ sym, start: i / 10, end: (i + 1) / 10 }));
}

describe('splitWords', () => {
  it('highlights words without their punctuation but phonemises the whole token', () => {
    const text = '"Well," she said — $3.50 (quietly).';
    const words = splitWords(text);
    expect(words.map((w) => text.slice(w.from, w.to))).toEqual(['Well', 'she', 'said', '—', '3.50', 'quietly']);
    expect(words[4]!.token).toBe('$3.50');
  });
});

describe('aligning sounds to words', () => {
  it('splits words eSpeak ran together', () => {
    // "in the house of the man" as eSpeak says it in a sentence, and each word alone.
    const sentence = 'ɪnðə hˈaʊs ɒvðə mˈæn';
    const alone = ['ˈɪn', 'ðə', 'hˈaʊs', 'ɒv', 'ðə', 'mˈæn'].map(soundsOf);
    const owners = ownersOf(soundsOf(sentence), alone);
    expect(owners).toEqual([0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 4, 4, 5, 5, 5]);
  });

  it('matches reduced vowels in running speech to the word said alone', () => {
    // "going to be" — alone "to" is tuː and "be" is biː; in the sentence təbɪ.
    const sentence = 'ɡˌəʊɪŋ təbɪ fˈaɪn';
    const alone = ['ɡˈəʊɪŋ', 'tuː', 'biː', 'fˈaɪn'].map(soundsOf);
    const times = wordTimes(timed(sentence), alone);
    expect(times.map((t) => t && [t.start, t.end].map((v) => Math.round(v * 10)))).toEqual([
      [0, 5],
      [5, 7],
      [7, 9],
      [9, 13],
    ]);
  });

  it('gives a number all the words it is said as, and skips punctuation', () => {
    const sentence = 'ɪn nˈaɪntiːnhˈʌndɹɪdən nˈaɪntɪ, dˈɒktɐ.smˈɪθ';
    const alone = ['ˈɪn', 'nˈaɪntiːnhˈʌndɹɪdən nˈaɪntɪ,', 'dˈɒktɐ.', '', 'smˈɪθ'].map(soundsOf);
    const times = wordTimes(timed(sentence), alone);
    expect(times[0]).toEqual({ start: 0, end: 0.2 });
    expect(times[1]!.start).toBeCloseTo(0.2);
    expect(times[1]!.end).toBeCloseTo(2.4);
    expect(times[3]).toBeNull();
    expect(times[4]!.end).toBeCloseTo(3.3);
    // Strictly in reading order.
    const starts = times.filter(Boolean).map((t) => t!.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('copes with a sound eSpeak inserts only in context', () => {
    // Linking r: "far away" → fɑːɹ ɐwˈeɪ, but "far" alone is fɑː.
    const owners = ownersOf(soundsOf('fˈɑːɹ ɐwˈeɪ'), ['fˈɑː', 'ɐwˈeɪ'].map(soundsOf));
    expect(owners).toEqual([0, 0, 0, 1, 1, 1, 1]);
  });

  it('returns no owners when there is nothing to align', () => {
    expect(ownersOf([], [['a']])).toEqual([]);
    expect(ownersOf(['a', 'b'], [])).toEqual([-1, -1]);
  });
});
