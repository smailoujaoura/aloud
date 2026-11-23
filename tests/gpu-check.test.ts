import { describe, expect, it } from 'vitest';
import { GPU_ALIKE, envelopeSimilarity, notSound, seededRandom, similarity } from '@/engine/gpu-check';

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

  it('Supertonic\'s GPU test hears the same words through different samples, and not other words', () => {
    // Speech-like: bursts of sound (syllables) with gaps, carried by noise.
    const speech = (bursts: Array<[number, number]>, seed: number): Float32Array => {
      const r = seededRandom(seed);
      return Float32Array.from({ length: RATE * 2 }, (_, i) => {
        const t = i / RATE;
        const on = bursts.some(([from, to]) => t >= from && t < to);
        return (on ? 0.3 : 0.002) * (r() - 0.5);
      });
    };
    const words: Array<[number, number]> = [[0.1, 0.3], [0.4, 0.55], [0.7, 1.0], [1.2, 1.3], [1.45, 1.8]];
    const cpu = speech(words, 1);
    // A working GPU: the same words, its samples all different (its arithmetic differs in the last
    // digits). Compared sample by sample that is no match at all, which failed real GPUs.
    const gpu = speech(words, 2);
    expect(Math.abs(similarity(cpu, gpu))).toBeLessThan(0.1);
    expect(envelopeSimilarity(cpu, gpu, RATE)).toBeGreaterThan(0.9);
    // Gibberish: sounds of the same kind, in other places.
    const babble = speech([[0.0, 0.12], [0.3, 0.4], [0.55, 0.7], [1.0, 1.2], [1.3, 1.45], [1.8, 2.0]], 3);
    expect(envelopeSimilarity(cpu, babble, RATE)).toBeLessThan(GPU_ALIKE);
  });

  it('the same seed gives the same noise, so both runs of the test start alike', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(Array.from({ length: 1000 }, seededRandom(7)).every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
