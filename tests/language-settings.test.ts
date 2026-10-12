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
