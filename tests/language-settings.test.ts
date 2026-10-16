import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings, withDefaults, type Settings } from '@/shared/settings';

describe('languageVoices setting', () => {
  it('defaults to none, so existing profiles read exactly as before', () => {
    expect(withDefaults({}).languageVoices).toEqual({});
    expect(DEFAULT_SETTINGS.matchPageLanguage).toBe(true);
  });

  it('keeps only well-formed entries from storage or a backup', () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      languageVoices: {
        it: { engine: 'piper', voice: 'it_IT-paola-medium' },
        fr: { engine: 'kokoro', voice: 'ff_siwis' },
        'en-GB': { engine: 'piper', voice: 'x' }, // not a primary language
        de: { engine: 'espeak', voice: 'x' }, // no such engine
        es: { engine: 'piper', voice: '' },
        pt: 'pf_dora',
      },
    } as unknown as Settings;
    expect(sanitizeSettings(raw).languageVoices).toEqual({
      it: { engine: 'piper', voice: 'it_IT-paola-medium' },
      fr: { engine: 'kokoro', voice: 'ff_siwis' },
    });
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, languageVoices: 'nope' } as unknown as Settings).languageVoices).toEqual({});
  });
});

describe('the bar, and voice choices', () => {
  it('keeps the bar in place by default', () => {
    expect(DEFAULT_SETTINGS.barAutoHide).toBe(false);
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, barAutoHide: 'yes' } as unknown as Settings).barAutoHide).toBe(false);
  });

  it('voices always follow the language; removed languages and the other-languages voice are kept well-formed', () => {
    const s = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      matchPageLanguage: false,
      removedLanguages: ['it', 'it', 'Italian', 3],
      otherVoice: { engine: 'kokoro', voice: 'if_sara' },
    } as unknown as Settings);
    expect(s.matchPageLanguage).toBe(true);
    expect(s.removedLanguages).toEqual(['it']);
    expect(s.otherVoice).toEqual({ engine: 'kokoro', voice: 'if_sara' });
  });
});

describe('Supertonic, removed', () => {
  it('settings and backups made with it load cleanly: its voices and settings are dropped', () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      engine: 'supertonic',
      supertonicVoice: 'F1',
      supertonicSteps: 6,
      languageVoices: { en: { engine: 'supertonic', voice: 'F1' }, it: { engine: 'piper', voice: 'it_IT-paola-medium' } },
      otherVoice: { engine: 'supertonic', voice: 'M2' },
    } as unknown as Settings;
    const s = sanitizeSettings(raw);
    expect(s.engine).toBe(DEFAULT_SETTINGS.engine);
    expect(s.languageVoices).toEqual({ it: { engine: 'piper', voice: 'it_IT-paola-medium' } });
    expect(s.otherVoice).toBeNull();
    expect(s).not.toHaveProperty('supertonicVoice');
    expect(s).not.toHaveProperty('supertonicSteps');
  });
});
