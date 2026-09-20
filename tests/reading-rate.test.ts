import { vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { describe, expect, it } from 'vitest';
import { BASE_WPM, measuredWpm, speedLabel, wordsPerMinute } from '@/shared/reading-rate';

describe('reading rate', () => {
  it('scales each engine’s measured rate with the speed', () => {
    expect(wordsPerMinute('piper', 1)).toBe(185);
    expect(wordsPerMinute('piper', 2)).toBe(375);
    expect(wordsPerMinute('kokoro', 1)).toBe(165);
    expect(wordsPerMinute('supertonic', 1.5)).toBe(225);
    expect(BASE_WPM.piper).toBeGreaterThan(BASE_WPM.supertonic);
  });

  it('labels a speed with what it means', () => {
    expect(speedLabel('kokoro', 1.4)).toBe('1.40× · 230 wpm');
  });

  it('measures the real rate once there is enough audio', () => {
    expect(measuredWpm(44, 14.1)).toBe(185);
    // Too little to trust: a short sentence is mostly its trailing silence.
    expect(measuredWpm(3, 2)).toBeNull();
    expect(measuredWpm(30, 3)).toBeNull();
  });
});
