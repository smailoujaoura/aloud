import { describe, it, expect } from 'vitest';
import { estimatedWordTimings } from '@/audio/estimate-words';

/** Silence, then a tone for `seconds`, then silence, at 1 kHz. */
function audio(lead: number, seconds: number, tail: number): Float32Array {
  const sr = 1000;
  const pcm = new Float32Array(Math.round((lead + seconds + tail) * sr));
  for (let i = Math.round(lead * sr); i < Math.round((lead + seconds) * sr); i++) pcm[i] = Math.sin(i) * 0.5 + (i % 2 ? 0.3 : -0.3);
  return pcm;
}

describe('estimatedWordTimings', () => {
  it('shares the speech, not the silence around it, over the words in order', () => {
    const t = estimatedWordTimings('Il cielo sta cadendo!', audio(0.5, 2, 0.5), 1000);
    expect(t.map((w) => w.from)).toEqual([0, 3, 9, 13]);
    expect(t[0]!.start).toBeGreaterThanOrEqual(0.49);
    expect(t.at(-1)!.end).toBeLessThanOrEqual(2.51);
    for (let i = 1; i < t.length; i++) expect(t[i]!.start).toBeGreaterThanOrEqual(t[i - 1]!.end);
  });

  it('gives longer words longer, and leaves a pause after a comma', () => {
    const t = estimatedWordTimings('A wonderful, day', audio(0, 3, 0), 1000);
    const len = (i: number) => t[i]!.end - t[i]!.start;
    expect(len(1)).toBeGreaterThan(len(0));
    expect(t[2]!.start - t[1]!.end).toBeGreaterThan(0);
  });

  it('nothing for silence or no words', () => {
    expect(estimatedWordTimings('— …', audio(0, 1, 0), 1000)).toEqual([]);
    expect(estimatedWordTimings('Hello', new Float32Array(1000), 1000)).toEqual([]);
  });
});
