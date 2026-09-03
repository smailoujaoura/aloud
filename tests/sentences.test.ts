import { describe, it, expect } from 'vitest';
import { segmentSentences } from '@/segment/sentences';

describe('segmentSentences', () => {
  it('splits a simple paragraph into sentences with round-tripping offsets', () => {
    const text = 'The sky is blue. Grass is green! Is water wet? Yes.';
    const chunks = segmentSentences(text);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
    expect(chunks[0]!.text).toBe('The sky is blue.');
  });

  it('does not break on the abbreviation "Dr."', () => {
    const text = 'Dr. Smith arrived early. She was tired.';
    const chunks = segmentSentences(text);
    expect(chunks[0]!.text).toContain('Dr. Smith arrived early.');
    expect(chunks).toHaveLength(2);
  });

  it('clause-splits an over-long sentence', () => {
    const long =
      'This is a deliberately long sentence that goes on and on about nothing in particular; ' +
      'it then continues past a semicolon, and keeps adding clauses separated by commas, ' +
      'until it is definitely longer than the configured maximum chunk length for synthesis.';
    const chunks = segmentSentences(long, { maxChars: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(120);
  });

  it('assigns sequential indices', () => {
    const chunks = segmentSentences('One. Two. Three.');
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('handles text with no terminal punctuation', () => {
    const chunks = segmentSentences('just a fragment with no period');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('just a fragment with no period');
  });
});
