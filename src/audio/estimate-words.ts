/**
 * Word times for audio that came without them (Supertonic reports none, and Piper or Kokoro can
 * miss a sentence's alignment): the speech in the audio — leading and trailing silence trimmed —
 * shared out over the words by their length, with a little more after a comma and more after a
 * full stop, where a voice pauses. An estimate, close enough for the mark to move with the voice
 * rather than not move at all.
 */
import type { WordTiming } from '@/engine/protocol';
import { splitWords } from '@/engine/g2p/word-timing';

const LETTER = /[\p{L}\p{N}]/gu;

export function estimatedWordTimings(text: string, pcm: Float32Array, sampleRate: number): WordTiming[] {
  const words = splitWords(text).filter((w) => /[\p{L}\p{N}]/u.test(w.token));
  if (!words.length || !sampleRate || !pcm.length) return [];

  // Where speech is: the first and last stretch louder than a fraction of the peak.
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  if (peak === 0) return [];
  const floor = peak * 0.06;
  let first = 0;
  while (first < pcm.length && Math.abs(pcm[first]!) < floor) first++;
  let last = pcm.length - 1;
  while (last > first && Math.abs(pcm[last]!) < floor) last--;
  const from = first / sampleRate;
  const to = (last + 1) / sampleRate;
  if (to - from < 0.05) return [];

  const weights = words.map((w) => {
    const letters = Math.max(1, (w.token.match(LETTER) ?? []).length);
    const after = /[.!?…]["”»’)]*$/u.test(w.token) ? 4 : /[,;:]["”»’)]*$/u.test(w.token) ? 2 : 0;
    return { say: letters + 1, after };
  });
  const total = weights.reduce((sum, w) => sum + w.say + w.after, 0);
  const perUnit = (to - from) / total;
  const out: WordTiming[] = [];
  let at = from;
  words.forEach((w, i) => {
    const say = weights[i]!.say * perUnit;
    out.push({ from: w.from, to: w.to, start: at, end: at + say });
    at += say + weights[i]!.after * perUnit;
  });
  return out;
}
