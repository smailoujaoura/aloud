import { describe, it, expect } from 'vitest';
import { wordStyleCss, wordTone } from '@/highlight/highlighter';

describe('wordTone', () => {
  it('derives a lighter layer and a darker underline from the sentence colour', () => {
    expect(wordTone('rgba(255, 214, 10, 0.45)')).toEqual({ fill: 'rgba(255, 214, 10, 0.32)', line: 'rgb(140, 118, 6)' });
    expect(wordTone('rgb(100, 200, 50)').fill).toBe('rgba(100, 200, 50, 0.50)');
    expect(wordTone('gold')).toEqual({ fill: 'gold', line: 'currentColor' });
  });
});

describe('wordStyleCss', () => {
  it('shades the word for "darker" and draws nothing across the text', () => {
    const css = wordStyleCss('rgba(255, 214, 10, 0.45)', 'darker');
    expect(css).toContain('background-color: rgba(255, 214, 10, 0.32)');
    expect(css).not.toContain('text-decoration');
  });

  it('underlines in the darker hue for "underline", leaving the fill to the sentence', () => {
    const css = wordStyleCss('rgba(255, 214, 10, 0.45)', 'underline');
    expect(css).toContain('underline 3px rgb(140, 118, 6)');
    expect(css).not.toContain('background-color');
  });
});
