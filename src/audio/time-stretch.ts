/**
 * Faster speech at the same pitch, for speeds the voice models cannot reach themselves.
 *
 * A model reads faster by giving each sound fewer audio frames, but never fewer than one, and its
 * pauses shrink less than its words: asked for 2× Piper read 1.6× as fast, and asked for 4× only
 * 2.1× (Kokoro 1.8× and 2.2×). So 4× sounded hardly faster than 2×. Past MODEL_MAX_SPEED the
 * model reads at that speed and the audio is sped up by the rest, here.
 *
 * WSOLA (waveform-similarity overlap-add): the speech is cut into overlapping windows, taken
 * further apart than they are laid down, and each is taken where it best continues the one before —
 * so the waveform stays smooth and the pitch stays the speaker's, where simply playing it faster
 * would raise it. About 30 ms windows, half overlapping, searched ±10 ms.
 */

/** The fastest the models are asked to read; past it the audio is sped up instead. */
export const MODEL_MAX_SPEED = 1.5;

/** How to reach `speed`: what the model is asked for, and by how much its audio is sped up then. */
export function splitSpeed(speed: number): { model: number; stretch: number } {
  if (!(speed > MODEL_MAX_SPEED)) return { model: speed, stretch: 1 };
  return { model: MODEL_MAX_SPEED, stretch: speed / MODEL_MAX_SPEED };
}

/** `pcm` played `rate` times as fast (rate > 1), at the same pitch. */
export function timeStretch(pcm: Float32Array, sampleRate: number, rate: number): Float32Array {
  if (!(rate > 1.001) || pcm.length === 0) return pcm;
  const half = Math.max(16, Math.round(0.015 * sampleRate));
  const n = half * 2; // window
  const hs = half; // synthesis hop: windows laid down half overlapping
  const ha = hs * rate; // analysis hop: taken `rate` times further apart
  const tolerance = Math.round(0.01 * sampleRate);
  const outLength = Math.max(1, Math.round(pcm.length / rate));
  if (pcm.length < n + tolerance * 2) return resampleShort(pcm, outLength);

  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const out = new Float32Array(outLength + n);
  const weight = new Float32Array(outLength + n);

  let previous = 0;
  for (let k = 0; ; k++) {
    const at = k * hs;
    if (at >= outLength) break;
    const nominal = Math.round(k * ha);
    let from = Math.min(nominal, pcm.length - n);
    if (k > 0) from = bestMatch(pcm, previous + hs, nominal, tolerance, half);
    if (from < 0 || from + n > pcm.length) break;
    for (let i = 0; i < n; i++) {
      out[at + i]! += pcm[from + i]! * window[i]!;
      weight[at + i]! += window[i]!;
    }
    previous = from;
  }
  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) result[i] = weight[i]! > 1e-3 ? out[i]! / weight[i]! : out[i]!;
  return result;
}

/**
 * Where near `nominal` a window starts that best continues the audio after the previous window
 * (`natural` is where that continuation starts): the most similar waveform over the overlap,
 * compared every other sample — similar enough, at a quarter of the work.
 */
function bestMatch(pcm: Float32Array, natural: number, nominal: number, tolerance: number, overlap: number): number {
  const lo = Math.max(0, nominal - tolerance);
  const hi = Math.min(pcm.length - overlap * 2, nominal + tolerance);
  if (natural + overlap > pcm.length || hi < lo) return Math.min(Math.max(0, nominal), pcm.length - overlap * 2);
  let best = lo;
  let bestScore = -Infinity;
  for (let from = lo; from <= hi; from++) {
    let score = 0;
    for (let i = 0; i < overlap; i += 2) score += pcm[from + i]! * pcm[natural + i]!;
    if (score > bestScore) {
      bestScore = score;
      best = from;
    }
  }
  return best;
}

/** A clip too short to window: shortened by dropping samples evenly (a few milliseconds of audio). */
function resampleShort(pcm: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = pcm[Math.min(pcm.length - 1, Math.floor((i * pcm.length) / length))]!;
  return out;
}
