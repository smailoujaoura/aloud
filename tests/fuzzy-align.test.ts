import { describe, it, expect } from 'vitest';
import { Aligner, canonicalize, diceSimilarity } from '@/align/fuzzy-align';

describe('canonicalize', () => {
  it('lowercases, keeps alphanumerics, collapses separators, and maps back', () => {
    const { text, map } = canonicalize('  Hello,   World! 42 ');
    expect(text).toBe('hello world 42');
    // Every canonical char maps to a source index holding that (or a separator) char.
    expect(map).toHaveLength(text.length);
    expect(map[0]).toBe(2); // 'H'
  });
});

describe('diceSimilarity', () => {
  it('is 1 for identical strings and lower for different ones', () => {
    expect(diceSimilarity('night', 'night')).toBe(1);
    expect(diceSimilarity('night', 'nacht')).toBeLessThan(1);
    expect(diceSimilarity('night', 'nacht')).toBeGreaterThan(0);
  });
});

describe('Aligner', () => {
  const dom =
    'Intro heading\nThe quick brown fox jumps over the lazy dog. ' +
    'It was a bright cold day in April, and the clocks were striking thirteen. ' +
    'The quick brown fox jumps over the lazy dog again.';

  it('locates an exact sentence and returns round-tripping offsets', () => {
    const a = new Aligner(dom);
    const loc = a.locate('The quick brown fox jumps over the lazy dog.', 0);
    expect(loc).not.toBeNull();
    expect(dom.slice(loc!.start, loc!.end).toLowerCase()).toContain('the quick brown fox jumps over the lazy dog');
    expect(loc!.confidence).toBe(1);
  });

  it('advances the cursor so a repeated sentence resolves to the later occurrence', () => {
    const a = new Aligner(dom);
    const first = a.locate('The quick brown fox jumps over the lazy dog.', 0)!;
    const second = a.locate('The quick brown fox jumps over the lazy dog again.', 1)!;
    expect(second.start).toBeGreaterThan(first.start);
  });

  it('tolerates minor punctuation / whitespace differences', () => {
    const a = new Aligner(dom);
    const loc = a.locate('It was a bright cold day in April and the clocks were striking thirteen', 0);
    expect(loc).not.toBeNull();
    expect(loc!.confidence).toBeGreaterThan(0.6);
  });

  it('returns null when the sentence is absent', () => {
    const a = new Aligner(dom);
    expect(a.locate('completely unrelated content that never appears here', 0)).toBeNull();
  });
});
