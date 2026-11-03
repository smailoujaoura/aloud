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

  it('is the multilingual model, from the pinned copy: no language experimental', () => {
    expect(m.phonon!.modelId).toBe('gradium/phonon-40m-multilingual');
    expect(m.phonon!.base).toBe('https://huggingface.co/smailoujaoura/phonon-40m-multilingual/resolve/514a70f83654b3a81844cc01bbe5438254080433');
    expect(m.phonon!.sha256.weights).toBe('96fa067813244e0c6c5997b98ec2596b65ec8574b14916b48e97db056ff97e27');
    expect(m.phonon!.license).toMatch(/non-commercial/);
    expect(m.phonon!.experimentalLanguages).toEqual([]);
    for (const tag of ['en-US', 'fr-FR', 'es-MX', 'de-DE', 'pt-BR']) expect(phononExperimental(tag, m.phonon!.experimentalLanguages)).toBe(false);
    // The marking itself still works, for a model that reads a language less well.
    expect(phononExperimental('fr-FR', ['fr'])).toBe(true);
  });

  it('a chosen Phonon voice is saved as the Phonon voice, not the Piper one', () => {
    expect(voiceKeyFor('phonon')).toBe('phononVoice');
    expect(voiceKeyFor('server')).toBe('serverVoice');
  });
});

describe('who reads a language, with Phonon installed', () => {
  const zoey = { engine: 'phonon' as const, id: 'NbpkqMVS3CJeq2j8', label: 'Zoey', language: 'en-US' };
  const noemie = { engine: 'phonon' as const, id: 'FXxJ9mANRq6BCTX5', label: 'Noémie', language: 'fr-FR' };
  // A voice of a language the model reads less well, as `experimentalLanguages` would mark it.
  const shaky = { ...noemie, experimental: true };
  const kokoroEn = { engine: 'kokoro' as const, id: 'af_heart', label: 'Heart', language: 'en-us' };
  const supertonicFr = { engine: 'supertonic' as const, id: 'F1@fr', label: 'Female 1', language: 'fr' };
  const piperFr = { engine: 'piper' as const, id: 'fr_FR-siwis-medium', label: 'Siwis', language: 'fr_FR' };

  it('English goes to Phonon, before Supertonic and Kokoro', () => {
    expect(pickVoiceForLanguage('en', null, [kokoroEn, { ...supertonicFr, id: 'F1@en', language: 'en' }, zoey])?.engine).toBe('phonon');
  });

  it('French goes to Phonon first too, as English does: its model reads both properly', () => {
    expect(pickVoiceForLanguage('fr', null, [piperFr, supertonicFr, noemie])?.id).toBe('FXxJ9mANRq6BCTX5');
  });

  it('a voice marked experimental comes after every other engine’s', () => {
    expect(pickVoiceForLanguage('fr', null, [shaky, piperFr])?.engine).toBe('piper');
    expect(pickVoiceForLanguage('fr', zoey, [shaky, supertonicFr])?.engine).toBe('supertonic');
  });

  it('never picks one of its characters by itself: a narrator reads, then any other English voice', () => {
    const captain = { engine: 'phonon' as const, id: 'captain', label: 'Captain Silas Blackwater', language: 'en' };
    const piperEn = { engine: 'piper' as const, id: 'en_US-lessac-medium', label: 'Lessac', language: 'en_US' };
    expect(pickVoiceForLanguage('en', noemie, [captain, zoey])?.id).toBe('NbpkqMVS3CJeq2j8');
    expect(pickVoiceForLanguage('en', noemie, [captain, piperEn])?.id).toBe('en_US-lessac-medium');
    expect(pickVoiceForLanguage('en', noemie, [captain])?.id).toBe('captain');
  });

  it('…and is still taken when it is the only voice for its language', () => {
    expect(pickVoiceForLanguage('fr', zoey, [zoey, shaky])?.id).toBe('FXxJ9mANRq6BCTX5');
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
  it('say nothing of "experimental": every language is read properly', () => {
    const list = listVoices('phonon', m);
    expect(list.find((v) => v.id === 'FXxJ9mANRq6BCTX5')?.label).toBe('Noémie · female');
    expect(list.find((v) => v.id === 'NbpkqMVS3CJeq2j8')?.label).toBe('Zoey · female');
    expect(list.some((v) => v.experimental)).toBe(false);
    // A model with one experimental language would say so, though.
    const withOne = { ...m, phonon: { ...m.phonon!, experimentalLanguages: ['fr'] } };
    expect(listVoices('phonon', withOne).find((v) => v.id === 'FXxJ9mANRq6BCTX5')?.label).toBe('Noémie · female · experimental');
  });
});
