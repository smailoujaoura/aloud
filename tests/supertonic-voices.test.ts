import { describe, expect, it } from 'vitest';
import manifest from '../public/models.json';
import { parseSupertonicVoice, supertonicVoiceId, supertonicVoices } from '@/shared/supertonic-voices';
import { voiceLanguage } from '@/shared/language-voice';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '@/shared/settings';
import { pickVoiceForLanguage } from '@/shared/language-voice';
import type { ModelManifest } from '@/engine/engines/types';

const m = manifest as unknown as ModelManifest;

describe('Supertonic 3 voices: a style in a language', () => {
  it('names a voice by style and language, and reads it back', () => {
    expect(supertonicVoiceId('M3', 'ko')).toBe('M3@ko');
    expect(parseSupertonicVoice('M3@ko')).toEqual({ style: 'M3', language: 'ko' });
    // Saved by Supertonic 2, which read English only.
    expect(parseSupertonicVoice('F1')).toEqual({ style: 'F1', language: 'en' });
  });

  it('offers every style in every one of the 31 languages', () => {
    const all = supertonicVoices(m);
    expect(m.supertonic?.languages).toHaveLength(31);
    expect(all).toHaveLength(10 * 31);
    expect(all.filter((v) => v.language === 'ja').map((v) => v.style)).toEqual(Object.keys(m.supertonic!.voices));
  });

  it('routes by the language in the name', () => {
    expect(voiceLanguage('supertonic', 'F2@de', m)).toBe('de');
    const installed = supertonicVoices(m).map((v) => ({ engine: 'supertonic' as const, id: v.id, label: v.label, language: v.language }));
    // A Croatian page — no Piper or Kokoro voice reads it — gets a Supertonic voice in Croatian.
    expect(pickVoiceForLanguage('hr', null, installed)?.id).toMatch(/@hr$/);
  });

  it('carries Supertonic 2 settings over: a bare style is the same voice, in English', () => {
    const s = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      supertonicVoice: 'M2',
      languageVoices: { en: { engine: 'supertonic', voice: 'F4' }, de: { engine: 'supertonic', voice: 'M1@de' } },
    } as Settings);
    expect(s.supertonicVoice).toBe('M2@en');
    expect(s.languageVoices).toEqual({ en: { engine: 'supertonic', voice: 'F4@en' }, de: { engine: 'supertonic', voice: 'M1@de' } });
  });

  it('on Auto, Supertonic reads a language the current voice does not, whatever engine is reading', () => {
    const thorsten = { engine: 'piper' as const, id: 'de_DE-thorsten-medium', label: 'Thorsten', language: 'de_DE' };
    const m1 = { engine: 'supertonic' as const, id: 'M1@de', label: 'Male 1', language: 'de' };
    const heart = { engine: 'kokoro' as const, id: 'af_heart', label: 'Heart', language: 'en-us' };
    // Reading with Kokoro, which has no German: Supertonic's German, not Piper's, whatever the page's tag.
    expect(pickVoiceForLanguage('de-DE', heart, [thorsten, m1])?.id).toBe('M1@de');
    expect(pickVoiceForLanguage('de', heart, [thorsten, m1])?.id).toBe('M1@de');
    // Reading with Piper: still Supertonic's German — Supertonic first, everywhere.
    const alba = { engine: 'piper' as const, id: 'en_GB-alba-medium', label: 'Alba', language: 'en_GB' };
    expect(pickVoiceForLanguage('de', alba, [thorsten, m1])?.id).toBe('M1@de');
  });

  it('Supertonic reads Italian before Kokoro, GPU or not', () => {
    const sara = { engine: 'kokoro' as const, id: 'if_sara', label: 'Sara', language: 'it' };
    const f1 = { engine: 'supertonic' as const, id: 'F1@it', label: 'Female 1', language: 'it' };
    const alba = { engine: 'piper' as const, id: 'en_GB-alba-medium', label: 'Alba', language: 'en_GB' };
    expect(pickVoiceForLanguage('it', alba, [sara, f1])?.id).toBe('F1@it');
    expect(pickVoiceForLanguage('it', alba, [f1, sara])?.id).toBe('F1@it');
  });

  it('Supertonic even before the engine already reading: a Kokoro reader gets French from Supertonic', () => {
    const heart = { engine: 'kokoro' as const, id: 'af_heart', label: 'Heart', language: 'en-us' };
    const siwis = { engine: 'kokoro' as const, id: 'ff_siwis', label: 'Siwis', language: 'fr-fr' };
    const f1 = { engine: 'supertonic' as const, id: 'F1@fr', label: 'Female 1', language: 'fr' };
    expect(pickVoiceForLanguage('fr', heart, [siwis, f1])?.id).toBe('F1@fr');
    // Without Supertonic, the current engine as before.
    const piperFr = { engine: 'piper' as const, id: 'fr_FR-siwis-medium', label: 'Siwis', language: 'fr_FR' };
    expect(pickVoiceForLanguage('fr', heart, [siwis, piperFr])?.id).toBe('ff_siwis');
  });
});
