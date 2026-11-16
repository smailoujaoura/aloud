import { describe, expect, it } from 'vitest';
import { notSound, seededRandom, similarity } from '@/engine/gpu-check';

const RATE = 24000;
const tone = (seconds: number, amp = 0.3, f = 220) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / RATE));

describe('does the GPU really speak', () => {
  it('sound passes', () => {
    expect(notSound(tone(1), RATE)).toBeNull();
  });

  it('silence, NaN, a blip or clipped noise do not (Kokoro on Firefox for Windows was silent)', () => {
    expect(notSound(new Float32Array(RATE), RATE)).toBe('silent');
    const nan = tone(1);
    nan[500] = Number.NaN;
    expect(notSound(nan, RATE)).toBe('not numbers');
    expect(notSound(tone(0.05), RATE)).toBe('too short');
    expect(notSound(Float32Array.from({ length: RATE }, (_, i) => (i % 2 ? 1 : -1)), RATE)).toBe('clipped noise');
  });

  it('the same sound is alike; another is not (Supertonic said gibberish there)', () => {
    const a = tone(1);
    const nearlyA = a.map((x, i) => x + 0.01 * Math.sin(i));
    expect(similarity(a, nearlyA)).toBeGreaterThan(0.99);
    const r = seededRandom(1);
    const noise = Float32Array.from({ length: a.length }, () => r() - 0.5);
    expect(Math.abs(similarity(a, noise))).toBeLessThan(0.1);
    expect(similarity(a, tone(1, 0.3, 330))).toBeLessThan(0.1);
  });

  it('the same seed gives the same noise, so both runs of the test start alike', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(Array.from({ length: 1000 }, seededRandom(7)).every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
