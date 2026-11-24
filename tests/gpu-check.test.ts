import { describe, expect, it } from 'vitest';
import { GPU_ALIKE, NOISE_FLATNESS, NOISE_WHITENED, envelopeSimilarity, notSound, seededRandom, similarity, soundStats, spectralFlatness, tooNoisy, whitenedFlatness } from '@/engine/gpu-check';

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

  it('noise does not pass for a voice: a GPU computing wrongly is loud, finite and unclipped (#10)', () => {
    // Voiced, like speech: a 140 Hz voice with falling harmonics, in syllables.
    const voice = Float32Array.from({ length: RATE * 2 }, (_, i) => {
      const t = i / RATE;
      const on = Math.floor(t / 0.18) % 3 !== 2 ? 1 : 0.01;
      let x = 0;
      for (let h = 1; h <= 25; h++) x += Math.sin(2 * Math.PI * 140 * h * t) / h;
      return 0.1 * on * x;
    });
    expect(notSound(voice, RATE)).toBeNull();
    expect(tooNoisy(voice, RATE)).toBeNull();
    expect(spectralFlatness(voice, RATE)).toBeLessThan(NOISE_FLATNESS);

    const r = seededRandom(5);
    const white = Float32Array.from({ length: RATE * 2 }, () => 0.3 * (r() - 0.5));
    // Loud, finite, unclipped: notSound lets it through, which is why tooNoisy exists.
    expect(notSound(white, RATE)).toBeNull();
    expect(tooNoisy(white, RATE)).toBe('noise');
    let low = 0;
    const brownish = Float32Array.from({ length: RATE * 2 }, () => (low = 0.98 * low + 0.1 * (r() - 0.5)));
    expect(tooNoisy(brownish, RATE)).toBe('noise');
    // In syllables or not, noise is noise.
    const bursts = white.map((x, i) => (Math.floor(i / 3000) % 2 ? x : x * 0.02));
    expect(tooNoisy(bursts, RATE)).toBe('noise');
    // Noise that falls with frequency, as speech does: rumble and brown noise score like speech on
    // the spectrum as it is, and are caught on its first difference.
    for (const pole of [0.99, 0.995, 0.999, 1]) {
      let y = 0;
      const rumble = Float32Array.from({ length: RATE * 2 }, () => (y = pole * y + (r() - 0.5)));
      expect(spectralFlatness(rumble, RATE)).toBeLessThan(NOISE_FLATNESS);
      expect(tooNoisy(rumble, RATE)).toBe('noise');
    }
    expect(whitenedFlatness(voice, RATE)).toBeLessThan(NOISE_WHITENED);

    // Against the processor's take: a breathy voice, flat on both, passes; noise in its place does not.
    const breathy = voice.map((x, i) => x + 0.05 * (r() - 0.5) * (Math.floor(i / 4320) % 3 !== 2 ? 1 : 0.01));
    expect(tooNoisy(breathy, RATE, breathy.map((x) => x * 0.98))).toBeNull();
    expect(tooNoisy(white, RATE, breathy)).toBe('noise');

    expect(soundStats(white, RATE)).toMatch(/^2\.00 s, level 0\.\d{4}, clipped 0\.0%, flatness 0\.\d{4}, whitened 0\.\d{4}$/);
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
