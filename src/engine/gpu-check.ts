/**
 * Whether a voice on the graphics card really speaks.
 *
 * A model that loads on WebGPU can still compute nonsense there: on Windows, Firefox exposes WebGPU
 * to extension workers (since 141), and on it Kokoro was silent and Supertonic said gibberish
 * (issue #10), with nothing failing. So a voice loaded on the GPU says one short phrase first, and
 * is moved to the processor if that is not sound, or (Supertonic, same weights on both) not the
 * sound the processor makes from the same noise.
 */

export const GPU_TEST_TEXT = 'Hello there. This is a short test of the voice.';

/** Why `pcm` is not speech at all (not numbers, silent, clipped noise), or null when it could be. */
export function notSound(pcm: Float32Array, sampleRate: number): string | null {
  if (pcm.length < sampleRate * 0.15) return 'too short';
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]!;
    if (!Number.isFinite(x)) return 'not numbers';
    sum += x * x;
    if (Math.abs(x) >= 0.999) clipped++;
  }
  if (Math.sqrt(sum / pcm.length) < 0.003) return 'silent';
  if (clipped / pcm.length > 0.2) return 'clipped noise';
  return null;
}

/** How alike two clips are, sample by sample: Pearson correlation over their common length. */
export function similarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * How alike two clips are in loudness over time: the level of each 20 ms, in decibels, correlated.
 *
 * What the Supertonic GPU test compares (engines/supertonic.ts: checkGpu). Comparing the samples
 * themselves (`similarity`) failed working graphics cards: the GPU's arithmetic differs from the
 * processor's in its last digits, the flow-matching steps and the vocoder carry that into a
 * waveform whose every sample differs, and a phrase that sounds the same scored 0.34, in Chrome
 * and in Safari on a Mac alike, every time. Speech carries its words in when it is loud and when it
 * is quiet; that the GPU keeps (0.87 to 0.90 against the processor, measured), and gibberish, its
 * sounds in other places, does not.
 */
export function envelopeSimilarity(a: Float32Array, b: Float32Array, sampleRate: number): number {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const levels = (pcm: Float32Array): Float32Array => {
    const out = new Float32Array(Math.floor(pcm.length / frame));
    for (let f = 0; f < out.length; f++) {
      let sum = 0;
      for (let i = f * frame; i < (f + 1) * frame; i++) sum += pcm[i]! * pcm[i]!;
      out[f] = 20 * Math.log10(Math.sqrt(sum / frame) + 1e-4);
    }
    return out;
  };
  return similarity(levels(a), levels(b));
}

/** How alike the GPU's test phrase must be to the processor's, by `envelopeSimilarity`. */
export const GPU_ALIKE = 0.6;

/** The same numbers every time from the same seed (mulberry32): the same noise for both runs of a test. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
