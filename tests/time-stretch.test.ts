import { describe, expect, it } from 'vitest';
import { MODEL_MAX_SPEED, splitSpeed, timeStretch } from '@/audio/time-stretch';

const sr = 24000;
const tone = (hz: number, seconds: number): Float32Array => {
  const out = new Float32Array(Math.round(sr * seconds));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
};
/** Frequency from upward zero crossings, away from the edges. */
const pitch = (pcm: Float32Array): number => {
  const a = Math.floor(pcm.length * 0.1);
  const b = Math.floor(pcm.length * 0.9);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if (pcm[i - 1]! < 0 && pcm[i]! >= 0) crossings++;
  return crossings / ((b - a) / sr);
};

describe('faster speech at the same pitch', () => {
  it('the model reads up to 1.5×; the rest is the audio sped up', () => {
    expect(splitSpeed(1)).toEqual({ model: 1, stretch: 1 });
    expect(splitSpeed(MODEL_MAX_SPEED)).toEqual({ model: MODEL_MAX_SPEED, stretch: 1 });
    expect(splitSpeed(3)).toEqual({ model: 1.5, stretch: 2 });
    expect(splitSpeed(4).model * splitSpeed(4).stretch).toBeCloseTo(4);
  });

  it('is the requested length', () => {
    const input = tone(200, 2);
    for (const rate of [1.25, 2, 2.67]) expect(timeStretch(input, sr, rate).length).toBe(Math.round(input.length / rate));
  });

  it('keeps the pitch: a 200 Hz tone twice as fast is still 200 Hz, not 400', () => {
    const out = timeStretch(tone(200, 2), sr, 2);
    expect(pitch(out)).toBeGreaterThan(190);
    expect(pitch(out)).toBeLessThan(210);
  });

  it('leaves audio alone at 1×, and copes with a clip shorter than a window', () => {
    const input = tone(200, 1);
    expect(timeStretch(input, sr, 1)).toBe(input);
    expect(timeStretch(tone(200, 0.01), sr, 2).length).toBe(Math.round(240 / 2));
  });
});
