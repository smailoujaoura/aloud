import { describe, it, expect } from 'vitest';
import { spokenToSource } from '@/highlight/word-map';

/** The page text a spoken word maps to. */
function pageWord(spoken: string, source: string, word: string, nth = 0): string | null {
  let from = -1;
  for (let k = 0; k <= nth; k++) from = spoken.indexOf(word, from + 1);
  const span = spokenToSource(spoken, source)(from, from + word.length);
  return span ? source.slice(span[0], span[1]) : null;
}

describe('spokenToSource', () => {
  it('maps words one to one when nothing changed', () => {
    const text = 'The quick brown fox.';
    expect(spokenToSource(text, text)(4, 9)).toEqual([4, 9]);
  });

  it('lights the abbreviation for every word it was expanded into', () => {
    const source = 'Fruit, e.g. apples, is good.';
    const spoken = 'Fruit, for example apples, is good.';
    expect(pageWord(spoken, source, 'for')).toBe('e.g');
    expect(pageWord(spoken, source, 'example')).toBe('e.g');
    expect(pageWord(spoken, source, 'apples')).toBe('apples');
  });

  it('follows replacements and pronunciation rules', () => {
    const source = 'See https://example.com/a?b=c for the GPU details.';
    const spoken = 'See link for the gee pee you details.';
    expect(pageWord(spoken, source, 'link')).toBe('https://example.com/a?b=c');
    expect(pageWord(spoken, source, 'pee')).toBe('GPU');
    expect(pageWord(spoken, source, 'details')).toBe('details');
  });

  it('matches repeated words in order', () => {
    const source = 'the cat and THE dog';
    const spoken = 'the cat and the dog';
    expect(spokenToSource(spoken, source)(12, 15)).toEqual([12, 15]);
  });

  it('maps a spoken word with no page text to nothing', () => {
    const source = 'Hello world';
    const spoken = 'Hello there world';
    expect(pageWord(spoken, source, 'there')).toBeNull();
  });
});
