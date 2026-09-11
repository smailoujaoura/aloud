import { describe, it, expect } from 'vitest';
import {
  documentKey,
  excerptOf,
  resumeIndex,
  withPosition,
  type SavedPosition,
} from '@/shared/position-match';

const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} of the article.`);

function saved(index: number, text = sentences[index]!): SavedPosition {
  return { index, total: sentences.length, excerpt: excerptOf(text), savedAt: 1 };
}

describe('documentKey', () => {
  it('drops the fragment and tracking parameters, keeps meaningful ones', () => {
    expect(documentKey('https://a.example/post?id=7&utm_source=x&fbclid=y#section-2')).toBe(
      'https://a.example/post?id=7',
    );
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(documentKey('not a url')).toBe('not a url');
  });
});

describe('resumeIndex', () => {
  it('resumes at the saved index when its sentence is unchanged', () => {
    expect(resumeIndex(saved(8), sentences)).toBe(8);
  });

  it('follows the sentence when content above it moved', () => {
    const shifted = ['A new paragraph was inserted.', ...sentences];
    expect(resumeIndex(saved(8), shifted)).toBe(9);
  });

  it('declines when the sentence no longer exists', () => {
    expect(resumeIndex(saved(8, 'Something that is not on the page.'), sentences)).toBeNull();
  });

  it('does not offer to resume at the very start or at the very end', () => {
    expect(resumeIndex(saved(1), sentences)).toBeNull();
    expect(resumeIndex(saved(19), sentences)).toBeNull();
  });

  it('is null with nothing saved', () => {
    expect(resumeIndex(undefined, sentences)).toBeNull();
  });
});

describe('withPosition', () => {
  it('keeps only the most recent entries', () => {
    let map = {};
    for (let i = 0; i < 5; i++) {
      map = withPosition(map, `k${i}`, { index: i, total: 9, excerpt: '', savedAt: i }, 3);
    }
    expect(Object.keys(map).sort()).toEqual(['k2', 'k3', 'k4']);
  });
});
