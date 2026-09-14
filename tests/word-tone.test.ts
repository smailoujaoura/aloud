import { describe, it, expect } from 'vitest';
import { wordTone } from '@/highlight/highlighter';

describe('wordTone', () => {
  it('derives a lighter layer and a darker underline from the sentence colour', () => {
    expect(wordTone('rgba(255, 214, 10, 0.45)')).toEqual({ fill: 'rgba(255, 214, 10, 0.32)', line: 'rgb(140, 118, 6)' });
    expect(wordTone('rgb(100, 200, 50)').fill).toBe('rgba(100, 200, 50, 0.50)');
    expect(wordTone('gold')).toEqual({ fill: 'gold', line: 'currentColor' });
  });
});
