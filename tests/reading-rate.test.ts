import { describe, expect, it } from 'vitest';
import { currentWpm, speedLabel } from '@/shared/reading-rate';
import type { WordTiming } from '@/engine/protocol';

const sentence = 'Once you\'ve covered some of the basics, the best thing you can do is get out there and start using that knowledge in the "real world".';

function timedWords(text: string, durations: number[]): WordTiming[] {
  let start = 0;
  return [...text.matchAll(/\S+/g)].map((word, i) => {
    const end = start + durations[i]!;
    const timing = { from: word.index!, to: word.index! + word[0].length, start, end };
    start = end;
    return timing;
  });
}

describe('current speaking pace', () => {
  it('shows the multiplier without inventing a WPM for an engine or language', () => {
    expect(speedLabel(1.5)).toBe('1.50×');
  });

  it('measures the reported 26-word example from its own audio', () => {
    expect(currentWpm(sentence, 4, 2)).toBe(390);
    expect(currentWpm(sentence, 5, 2)).toBe(312);
    const timings = timedWords(sentence, Array(26).fill(4 / 26));
    expect(currentWpm(sentence, 4, 3.5, timings)).toBe(390);
  });

  it('follows a changing pace within the current sentence without counting future words', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const timings = timedWords(text, [...Array(8).fill(0.25), ...Array(4).fill(0.5)]);
    expect(currentWpm(text, 4, 1, timings)).toBe(240);
    expect(currentWpm(text, 4, 3.5, timings)).toBe(150);
  });

  it('measures short utterances instead of reverting to an engine average', () => {
    expect(currentWpm('No! No! No!', 0.75, 0.3)).toBe(240);
  });

  it('counts Hindi combining marks and contractions as parts of their words', () => {
    expect(currentWpm('नमस्ते, यह एक परीक्षण है।', 2, 1)).toBe(150);
    expect(currentWpm("You've done it.", 1, 0.5)).toBe(180);
  });

  it('falls to zero through silence and outside the speech buffer', () => {
    const timings = timedWords('Hello.', [0.5]);
    expect(currentWpm('Hello.', 4, 3, timings)).toBe(0);
    expect(currentWpm(sentence, 4, -0.2)).toBe(0);
    expect(currentWpm(sentence, 4, 4)).toBe(0);
  });

  it('does not display an invented rate for missing or invalid audio duration', () => {
    expect(currentWpm(sentence, 0, 1)).toBeNull();
    expect(currentWpm(sentence, NaN, 1)).toBeNull();
  });
});
