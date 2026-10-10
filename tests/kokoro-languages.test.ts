/**
 * Kokoro's other languages: Spanish, French, Hindi, Italian and Brazilian Portuguese, phonemised
 * by eSpeak-NG as Kokoro's reference implementation does, since kokoro-js only reads English.
 */
import { describe, expect, it } from 'vitest';
import { ESPEAK_LANGUAGE, toKokoroSymbols } from '@/engine/engines/kokoro';
import manifest from '../public/models.json';

describe('Kokoro beyond English', () => {
  it('lists only voices Aloud can speak: English through kokoro-js, the rest through eSpeak', () => {
    const ids = Object.keys(manifest.kokoro.voices);
    const unspeakable = ids.filter((id) => !'ab'.includes(id[0]!) && !ESPEAK_LANGUAGE[id[0]!]);
    expect(unspeakable).toEqual([]);
    // Japanese and Mandarin need phonemisers with no browser equivalent: not offered.
    expect(ids.some((id) => /^[jz]/.test(id))).toBe(false);
    for (const letter of 'efhip') expect(ids.some((id) => id[0] === letter), letter).toBe(true);
  });

  it('gives each new voice the language a page is matched by', () => {
    const v = manifest.kokoro.voices as Record<string, { language: string }>;
    expect(v.if_sara!.language).toBe('it');
    expect(v.ef_dora!.language).toBe('es');
    expect(v.ff_siwis!.language).toBe('fr-FR');
    expect(v.pf_dora!.language).toBe('pt-BR');
    expect(v.hf_alpha!.language).toBe('hi');
  });

  it('folds eSpeak’s affricates and diphthongs into Kokoro’s single symbols, tie mark or not', () => {
    expect(toKokoroSymbols('ˈpittsa')).toBe('ˈpitʦa');
    expect(toKokoroSymbols('ˈpit͡sa')).toBe('ˈpiʦa');
    expect(toKokoroSymbols('tʃao dʒelato')).toBe('ʧao ʤelato');
    expect(toKokoroSymbols('bon-ʒuʁ')).toBe('bonʒuʁ');
  });
});

describe('previews in the voice’s own language', () => {
  it('speaks the sample sentence in the language the voice is for', async () => {
    const { previewSentence, PREVIEW_SENTENCE } = await import('@/ui/voice-preview');
    expect(previewSentence('it')).toMatch(/^Questo è/);
    expect(previewSentence('pt-BR')).toMatch(/^Este é um/);
    expect(previewSentence('fr-FR')).toMatch(/^Voici/);
    expect(previewSentence('en-GB')).toBe(PREVIEW_SENTENCE);
    expect(previewSentence(undefined)).toBe(PREVIEW_SENTENCE);
  });
});

describe('reading a page in one of the new languages', () => {
  it('picks the downloaded Kokoro voice for an Italian page, and keeps English for an English one', async () => {
    const { pickVoiceForLanguage, voiceLanguage } = await import('@/shared/language-voice');
    const m = manifest as never;
    const voice = (id: string) => ({ engine: 'kokoro' as const, id, label: id, language: voiceLanguage('kokoro', id, m) });
    const saved = voice('af_heart');
    const installed = [voice('af_heart'), voice('if_sara'), voice('ef_dora'), voice('pf_dora')];
    expect(pickVoiceForLanguage('it', saved, installed)?.id).toBe('if_sara');
    expect(pickVoiceForLanguage('es-MX', saved, installed)?.id).toBe('ef_dora');
    expect(pickVoiceForLanguage('pt', saved, installed)?.id).toBe('pf_dora');
    expect(pickVoiceForLanguage('en', saved, installed)?.id ?? 'af_heart').toBe('af_heart');
  });
});
