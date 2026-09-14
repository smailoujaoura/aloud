import { describe, it, expect } from 'vitest';
import { languageName, pickVoiceForLanguage, primaryLanguage, type CandidateVoice } from '@/shared/language-voice';

const v = (engine: CandidateVoice['engine'], id: string, language: string): CandidateVoice => ({ engine, id, label: id, language });

const alba = v('piper', 'en_GB-alba-medium', 'en-GB');
const heart = v('kokoro', 'af_heart', 'en-US');
const siwis = v('piper', 'fr_FR-siwis-medium', 'fr-FR');
const upmc = v('piper', 'fr_FR-upmc-medium', 'fr-FR');
const thorsten = v('piper', 'de_DE-thorsten-medium', 'de-DE');

describe('primaryLanguage', () => {
  it('reduces any tag to its language', () => {
    expect(primaryLanguage('fr-FR')).toBe('fr');
    expect(primaryLanguage('en_GB')).toBe('en');
    expect(primaryLanguage('DE')).toBe('de');
    expect(primaryLanguage('')).toBe('');
    expect(primaryLanguage(undefined)).toBe('');
  });
});

describe('pickVoiceForLanguage', () => {
  it('switches to a downloaded voice in the page language', () => {
    expect(pickVoiceForLanguage('fr', alba, [alba, siwis, thorsten])).toBe(siwis);
  });

  it('keeps the current voice when it already speaks the page language', () => {
    expect(pickVoiceForLanguage('en-US', alba, [alba, heart])).toBeNull();
  });

  it('keeps the current voice when nothing downloaded speaks the page language', () => {
    expect(pickVoiceForLanguage('ja', alba, [alba, siwis])).toBeNull();
  });

  it('does nothing when the page language is unknown', () => {
    expect(pickVoiceForLanguage('', alba, [siwis])).toBeNull();
  });

  it('prefers the engine already in use', () => {
    const frenchKokoro = v('kokoro', 'ff_siwis', 'fr-FR');
    expect(pickVoiceForLanguage('fr', heart, [siwis, frenchKokoro])).toBe(frenchKokoro);
  });

  it('goes back to English from a foreign voice on an English page', () => {
    expect(pickVoiceForLanguage('en', siwis, [siwis, alba])).toBe(alba);
  });

  it('is stable between equal matches', () => {
    expect(pickVoiceForLanguage('fr', alba, [siwis, upmc])).toBe(siwis);
  });
});

describe('languageName', () => {
  it('names languages for messages', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('pt-BR')).toMatch(/Portuguese/);
  });
});
