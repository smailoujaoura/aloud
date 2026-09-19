// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { avatarStyle, piperVoiceName, voiceAvatar, voiceGender } from '@/ui/voice-avatar';
import type { ModelManifest } from '@/engine/engines/types';

const manifest = {
  piper: {},
  kokoro: { modelId: '', license: '', voices: { af_heart: { label: 'Heart', language: 'en-US', gender: 'female' }, bm_george: { label: 'George', language: 'en-GB', gender: 'male' } } },
  supertonic: { voices: { F1: { label: 'Female 1', gender: 'female' }, M2: { label: 'Male 2', gender: 'male' } } },
} as unknown as ModelManifest;

describe('voice gender', () => {
  it('comes from the voice data for Kokoro and Supertonic, and from Kokoro ids as a fallback', () => {
    expect(voiceGender('kokoro', 'af_heart', manifest)).toBe('female');
    expect(voiceGender('kokoro', 'bm_george', manifest)).toBe('male');
    expect(voiceGender('kokoro', 'am_adam', null)).toBe('male');
    expect(voiceGender('supertonic', 'F1', manifest)).toBe('female');
    expect(voiceGender('supertonic', 'M2', manifest)).toBe('male');
  });

  it('knows Piper speakers by name, groups multi-speaker sets, and does not guess the rest', () => {
    expect(piperVoiceName('en_GB-alba-medium')).toBe('alba');
    expect(piperVoiceName('en_GB-northern_english_male-medium')).toBe('northern_english_male');
    expect(voiceGender('piper', 'en_GB-alba-medium', null)).toBe('female');
    expect(voiceGender('piper', 'en_US-ryan-high', null)).toBe('male');
    expect(voiceGender('piper', 'de_DE-thorsten-medium', null)).toBe('male');
    expect(voiceGender('piper', 'en_GB-vctk-medium', null)).toBe('mixed');
    expect(voiceGender('piper', 'fr_FR-mls_1840-low', null)).toBe('mixed');
    expect(voiceGender('piper', 'en_US-sam-medium', null)).toBe('unknown');
  });
});

describe('avatars', () => {
  it('draws the same portrait for the same voice every time', () => {
    const a = voiceAvatar(document, 'kokoro:af_heart', 'female').outerHTML.replace(/av-[a-z0-9]+/g, 'id');
    const b = voiceAvatar(document, 'kokoro:af_heart', 'female').outerHTML.replace(/av-[a-z0-9]+/g, 'id');
    expect(a).toBe(b);
  });

  it('respects gender: female styles never have beards, male styles are short, unknown gets no face', () => {
    for (let i = 0; i < 200; i++) {
      const f = avatarStyle(`v${i}`, 'female');
      expect(['long', 'bob', 'bun', 'curls']).toContain(f.hair);
      expect(f.beard).toBe(false);
      const m = avatarStyle(`v${i}`, 'male');
      expect(['crop', 'side', 'buzz', 'curly-short']).toContain(m.hair);
    }
    const unknown = voiceAvatar(document, 'piper:en_US-sam-medium', 'unknown');
    expect(unknown.dataset.hair).toBe('none');
    expect(unknown.querySelector('ellipse')).toBeNull(); // no head drawn
    expect(voiceAvatar(document, 'piper:en_GB-vctk-medium', 'mixed').querySelectorAll('ellipse')).toHaveLength(2);
  });

  it('varies between voices', () => {
    const styles = new Set(Array.from({ length: 40 }, (_, i) => avatarStyle(`voice${i}`, 'male').hair));
    expect(styles.size).toBeGreaterThan(2);
  });
});

describe('avatar contrast', () => {
  it('never paints hair in nearly the skin colour', () => {
    const lum = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (let i = 0; i < 300; i++) {
      const svg = voiceAvatar(document, `kokoro:v${i}`, i % 2 ? 'female' : 'male');
      const skin = svg.querySelector('ellipse')!.getAttribute('fill')!;
      const hairFills = [...svg.querySelectorAll('path, circle')].map((n) => n.getAttribute('fill')).filter((f): f is string => !!f && f.startsWith('#') && f !== skin && f !== '#2a211c');
      for (const hair of hairFills) expect(Math.abs(lum(hair) - lum(skin))).toBeGreaterThan(0.16);
    }
  });
});
