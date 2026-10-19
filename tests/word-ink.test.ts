import { describe, it, expect } from 'vitest';
import { wordFill } from '@/highlight/highlighter';
import { blend, parseColor, readableTextColor, washFor, type Rgb } from '@/highlight/contrast';

/** The letters a word gets, as the highlighter decides them: against its fill over the sentence's. */
function wordInk(text: string, page: Rgb, sentence: string, word: { rgb: Rgb; strength: number } | null, style: 'darker' | 'underline' = 'darker'): string | null {
  const tone = page[0] + page[1] + page[2] > 382 ? 'light' : 'dark';
  const wash = washFor(parseColor(sentence)!, tone);
  const fill = wordFill(`rgba(${wash.rgb.join(',')},${wash.alpha})`, style, word && { ...word, tone });
  const letters = parseColor(text)!;
  return fill ? readableTextColor(letters, blend(wash, page), fill) : readableTextColor(letters, page, wash);
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

describe('the letters of the word being read stay readable', () => {
  it('black word colour at full strength on black text: white letters', () => {
    expect(wordInk('rgb(0, 0, 0)', WHITE, '#ffd60a', { rgb: BLACK, strength: 1 })).toBe('#ffffff');
  });

  it('a light word colour, or a faint one, leaves the page its own letters', () => {
    expect(wordInk('rgb(0, 0, 0)', WHITE, '#ffd60a', { rgb: [255, 149, 0], strength: 0.55 })).toBeNull();
    expect(wordInk('rgb(0, 0, 0)', WHITE, '#ffd60a', { rgb: BLACK, strength: 0.15 })).toBeNull();
  });

  it('white word colour at full strength on a dark page with white text: dark letters', () => {
    expect(wordInk('rgb(240, 240, 240)', [20, 20, 24], '#ffd60a', { rgb: WHITE, strength: 1 })).toBe('#101014');
  });

  it('an underline adds no fill: judged as the sentence is', () => {
    expect(wordInk('rgb(0, 0, 0)', WHITE, '#ffd60a', { rgb: BLACK, strength: 1 }, 'underline')).toBeNull();
  });
});
