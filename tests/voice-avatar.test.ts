// @vitest-environment happy-dom
import { vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { describe, expect, it } from 'vitest';
import { genericAvatar, piperVoiceName } from '@/ui/voice-avatar';

describe('piperVoiceName', () => {
  it('takes the speaker out of a voice id, hyphens and all', () => {
    expect(piperVoiceName('en_GB-alba-medium')).toBe('alba');
    expect(piperVoiceName('en_US-hfc_female-medium')).toBe('hfc_female');
    expect(piperVoiceName('en_GB-northern_english_male-medium')).toBe('northern_english_male');
  });
});

describe('genericAvatar', () => {
  it('is the same drawing for every voice, at the size asked for', () => {
    const doc = document;
    const a = genericAvatar(doc, 40);
    const b = genericAvatar(doc, 56);
    expect(a.getAttribute('width')).toBe('40');
    expect(b.getAttribute('width')).toBe('56');
    expect(a.innerHTML).toBe(b.innerHTML);
    expect(a.dataset.generic).toBe('true');
  });
});
