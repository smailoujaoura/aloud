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

/**
 * Which build of this test a remembered verdict came from (synth-host/entry.ts: gpuVerdicts). Bump
 * it whenever the test or an engine's `checkGpu` changes, and whenever ONNX Runtime Web is updated:
 * a verdict from an earlier build is then tested again. Without it, a Mac whose working GPU the
 * first build of Supertonic's test rejected kept Supertonic on the processor for good, and a GPU
 * making noise that the first Kokoro test let through was never tested again. And a verdict made
 * under one ONNX Runtime says nothing about the next: Kokoro was silent on the GPU in Firefox for
 * Windows under 1.22.0, while 1.31.1 spoke there (in its native WebGPU build; Aloud loads its JSEP
 * build, so whether that one speaks there is what the new test finds out).
 *
 * 4: ONNX Runtime Web 1.31.1.
 */
export const GPU_TEST_VERSION = 4;

/**
 * How noise-like the loud part of a clip is: the spectral flatness of each 1024-sample frame within
 * 30 dB of the loudest, up to 8 kHz, median. 0 is a pure tone, about 0.56 white noise.
 *
 * Speech is far from flat: its energy sits in harmonics and formants. Measured on a Mac's GPU,
 * all 28 English Kokoro voices, two sentences each: 0.0002 to 0.0127. Supertonic's breathier
 * voices are flatter (M2: 0.04, on the GPU and the processor alike), which is why its test compares
 * with the processor's take rather than with a fixed bar. White noise scores 0.565, but noise that
 * falls with frequency scores like speech: one-pole noise 0.033 down to 0.005, brown noise about 0,
 * which is why `whitenedFlatness` measures too. A voice a graphics card computes wrongly comes out
 * as noise of that kind (Kokoro's small model on a GPU did; issue #10 on Windows Firefox was
 * garbled), which `notSound` lets through: it is loud, finite and not clipped.
 */
export function spectralFlatness(pcm: Float32Array, sampleRate: number): number {
  return flatness(pcm, pcm, sampleRate);
}

/**
 * The same, of the clip's first difference: its spectrum tilted up 6 dB an octave. Speech, which
 * falls about that fast, is barely flatter for it; noise that falls too (rumble, brown noise, what
 * `spectralFlatness` scores like speech) comes out flat. Measured on a Mac's GPU, all 28 English
 * Kokoro voices and all 10 Supertonic styles, two sentences each: 0.011 to 0.12. White noise 0.26;
 * one-pole and brown (random-walk) noise 0.53 to 0.56.
 *
 * What no flatness catches: babble that is voiced, harmonic sounds in the wrong order (0.001).
 * Supertonic's test compares with the processor's take for that; Kokoro's cannot.
 */
export function whitenedFlatness(pcm: Float32Array, sampleRate: number): number {
  const diff = new Float32Array(pcm.length);
  for (let i = 1; i < pcm.length; i++) diff[i] = pcm[i]! - pcm[i - 1]!;
  return flatness(diff, pcm, sampleRate);
}

/** Median flatness of `x` over the frames where `level` is within 30 dB of its loudest. */
function flatness(x: Float32Array, level: Float32Array, sampleRate: number): number {
  const pcm = level;
  const N = 1024;
  if (pcm.length < N) return 0;
  const energy: number[] = [];
  for (let at = 0; at + N <= pcm.length; at += N / 2) {
    let e = 0;
    for (let i = at; i < at + N; i++) e += pcm[i]! * pcm[i]!;
    energy.push(e);
  }
  const loudest = Math.max(...energy);
  if (!(loudest > 0)) return 0;
  const top = Math.max(2, Math.min(N / 2, Math.floor(8000 / (sampleRate / N))));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const flat: number[] = [];
  energy.forEach((e, f) => {
    if (e < loudest * 1e-3) return;
    const at = (f * N) / 2;
    for (let i = 0; i < N; i++) {
      re[i] = x[at + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    let logSum = 0;
    let sum = 0;
    for (let k = 1; k <= top; k++) {
      const power = re[k]! * re[k]! + im[k]! * im[k]! + 1e-12;
      logSum += Math.log(power);
      sum += power;
    }
    flat.push(Math.exp(logSum / top) / (sum / top));
  });
  flat.sort((a, b) => a - b);
  return flat.length ? flat[Math.floor(flat.length / 2)]! : 0;
}

/** Flatter than this is noise, not a Kokoro voice: over twice its flattest voice measured (see above). */
export const NOISE_FLATNESS = 0.03;
/** The same for `whitenedFlatness`: two thirds above the flattest voice measured, below every noise. */
export const NOISE_WHITENED = 0.2;

/**
 * 'noise' when `pcm` is noise rather than a voice, by either measure, or null. With `reference`
 * (the same phrase made on the processor), only when it is also far flatter than that: a breathy
 * voice is flat on both, and Supertonic's test phrase, squeezed into 1.6 s, is flatter than speech.
 */
export function tooNoisy(pcm: Float32Array, sampleRate: number, reference?: Float32Array): string | null {
  const raw = spectralFlatness(pcm, sampleRate);
  const whitened = whitenedFlatness(pcm, sampleRate);
  const rawBar = reference ? Math.max(NOISE_FLATNESS, 3 * spectralFlatness(reference, sampleRate)) : NOISE_FLATNESS;
  const whitenedBar = reference ? Math.max(NOISE_WHITENED, 3 * whitenedFlatness(reference, sampleRate)) : NOISE_WHITENED;
  return raw > rawBar || whitened > whitenedBar ? 'noise' : null;
}

/** In-place radix-2 FFT; `re.length` a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(step * k);
        const s = Math.sin(step * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * c - im[b]! * s;
        const xi = re[b]! * s + im[b]! * c;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/** What the GPU test measured of a phrase, for the console: the numbers behind its verdict. */
export function soundStats(pcm: Float32Array, sampleRate: number): string {
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]!;
    if (Number.isFinite(x)) sum += x * x;
    if (Math.abs(x) >= 0.999) clipped++;
  }
  const rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
  return `${(pcm.length / sampleRate).toFixed(2)} s, level ${rms.toFixed(4)}, clipped ${((100 * clipped) / Math.max(1, pcm.length)).toFixed(1)}%, flatness ${spectralFlatness(pcm, sampleRate).toFixed(4)}, whitened ${whitenedFlatness(pcm, sampleRate).toFixed(4)}`;
}

/** Why `pcm` is not speech at all (not numbers, silent, clipped noise), or null when it could be. See also `tooNoisy`. */
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
