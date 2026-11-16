import { describe, expect, it } from 'vitest';
import { PHONON_ENGLISH, builtInFixes } from '@/segment/phonon-fixes';
import { applyPronunciations, type PronunciationRule } from '@/segment/pronunciations';

const SAMPLE: PronunciationRule[] = [{ from: 'volcano', to: 'vol-kay-no' }];

/** As session.ts normalizeAs: the reader's own fixes, then the engine's. */
const spoken = (text: string, engine: 'phonon' | 'kokoro', language: string, own: PronunciationRule[] = []) =>
  applyPronunciations(applyPronunciations(text, own, language), builtInFixes(engine, language, SAMPLE), language);

describe('Phonon’s built-in fixes', () => {
  it('apply when Phonon reads English, any English', () => {
    expect(spoken('A volcano erupted.', 'phonon', 'en')).toBe('A vol-kay-no erupted.');
    expect(spoken('Volcano!', 'phonon', 'en-GB')).toBe('vol-kay-no!');
  });

  it('not for another engine, or another language', () => {
    expect(spoken('A volcano erupted.', 'kokoro', 'en')).toBe('A volcano erupted.');
    expect(spoken('Le volcano.', 'phonon', 'fr')).toBe('Le volcano.');
  });

  it('the reader’s own fix for a word comes first and stands', () => {
    expect(spoken('A volcano erupted.', 'phonon', 'en', [{ from: 'volcano', to: 'vulcan-oh' }])).toBe('A vulcan-oh erupted.');
  });

  it('whole words only: a longer word that contains one is left alone', () => {
    expect(spoken('Volcanoes and volcanology.', 'phonon', 'en')).toBe('Volcanoes and volcanology.');
  });

  it('every shipped entry is a lowercase whole word with a reading', () => {
    for (const rule of PHONON_ENGLISH) {
      expect(rule.from).toMatch(/^[a-z][a-z'-]*$/);
      expect(rule.to.trim().length).toBeGreaterThan(0);
      expect(rule.to).toBe(rule.to.toLowerCase());
    }
  });
});
