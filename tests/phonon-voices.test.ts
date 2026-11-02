import { describe, expect, it } from 'vitest';
import manifest from '../public/models.json';
import { phononExperimental, phononLanguage } from '@/shared/phonon-voices';
import { pickVoiceForLanguage } from '@/shared/language-voice';
import { voiceKeyFor } from '@/shared/settings';
import { listVoices } from '@/shared/voice-catalog';
import type { ModelManifest } from '@/engine/engines/types';

const m = manifest as unknown as ModelManifest;

describe('Phonon voices', () => {
  it('has the 102 voices of the pinned catalogue, each checked by its SHA-256', () => {
    const voices = Object.entries(m.phonon!.voices);
    expect(voices).toHaveLength(102);
    for (const [, v] of voices) expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.phonon!.voices.NbpkqMVS3CJeq2j8?.label).toBe('Zoey');
    expect(listVoices('phonon', m)).toHaveLength(102);
  });

  it('its characters, and only they, have no region in their language (routing relies on it)', () => {
    for (const v of Object.values(m.phonon!.voices)) expect(v.language.includes('-'), v.label).toBe(!v.character);
  });

  it('loads with the text rules of its language; English for characters', () => {
    expect(phononLanguage('fr-FR')).toBe('fr');
    expect(phononLanguage('pt-BR')).toBe('pt');
    expect(phononLanguage('en-GB')).toBe('en');
    expect(phononLanguage('en')).toBe('en');
    expect(phononLanguage('it')).toBe('en');
  });

  it('marks French, Spanish, German and Portuguese experimental, not English', () => {
    const exp = m.phonon!.experimentalLanguages;
    expect(phononExperimental('en-US', exp)).toBe(false);
    for (const tag of ['fr-FR', 'es-MX', 'de-DE', 'pt-BR']) expect(phononExperimental(tag, exp)).toBe(true);
  });

  it('a chosen Phonon voice is saved as the Phonon voice, not the Piper one', () => {
    expect(voiceKeyFor('phonon')).toBe('phononVoice');
    expect(voiceKeyFor('server')).toBe('serverVoice');
  });
});

describe('who reads a language, with Phonon installed', () => {
  const zoey = { engine: 'phonon' as const, id: 'NbpkqMVS3CJeq2j8', label: 'Zoey', language: 'en-US' };
  const noemie = { engine: 'phonon' as const, id: 'FXxJ9mANRq6BCTX5', label: 'Noémie', language: 'fr-FR' };
  const kokoroEn = { engine: 'kokoro' as const, id: 'af_heart', label: 'Heart', language: 'en-us' };
  const supertonicFr = { engine: 'supertonic' as const, id: 'F1@fr', label: 'Female 1', language: 'fr' };
  const piperFr = { engine: 'piper' as const, id: 'fr_FR-siwis-medium', label: 'Siwis', language: 'fr_FR' };

  it('English goes to Phonon, before Supertonic and Kokoro', () => {
    expect(pickVoiceForLanguage('en', null, [kokoroEn, { ...supertonicFr, id: 'F1@en', language: 'en' }, zoey])?.engine).toBe('phonon');
  });

  it('French goes to any other engine first: Phonon only speaks it with mistakes', () => {
    expect(pickVoiceForLanguage('fr', null, [noemie, piperFr])?.engine).toBe('piper');
    expect(pickVoiceForLanguage('fr', zoey, [noemie, supertonicFr])?.engine).toBe('supertonic');
  });

  it('never picks one of its characters by itself: a narrator reads, then any other English voice', () => {
    const captain = { engine: 'phonon' as const, id: 'captain', label: 'Captain Silas Blackwater', language: 'en' };
    const piperEn = { engine: 'piper' as const, id: 'en_US-lessac-medium', label: 'Lessac', language: 'en_US' };
    expect(pickVoiceForLanguage('en', noemie, [captain, zoey])?.id).toBe('NbpkqMVS3CJeq2j8');
    expect(pickVoiceForLanguage('en', noemie, [captain, piperEn])?.id).toBe('en_US-lessac-medium');
    expect(pickVoiceForLanguage('en', noemie, [captain])?.id).toBe('captain');
  });

  it('…and to Phonon when it is the only French voice there is', () => {
    expect(pickVoiceForLanguage('fr', zoey, [zoey, noemie])?.id).toBe('FXxJ9mANRq6BCTX5');
  });
});

describe('Phonon runtime', () => {
  it('its Cache Storage store is the one the engine puts the model in for Firefox', async () => {
    const { readFileSync } = await import('node:fs');
    const fetchJs = readFileSync('node_modules/phonon-tts/fetch.js', 'utf8');
    const { PHONON_CACHE } = await import('@/engine/engines/phonon');
    expect(fetchJs).toContain(`export const CACHE_NAME = '${PHONON_CACHE}';`);
  });
});

describe('Phonon in the voice menus', () => {
  it('its experimental languages say so', () => {
    const list = listVoices('phonon', m);
    expect(list.find((v) => v.id === 'FXxJ9mANRq6BCTX5')?.label).toBe('Noémie · female · experimental');
    expect(list.find((v) => v.id === 'NbpkqMVS3CJeq2j8')?.label).toBe('Zoey · female');
  });
});
