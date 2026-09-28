import { describe, it, expect } from 'vitest';
import { Mp3Export, audioFileName } from '@/content/audio-export';

function tone(seconds: number, sampleRate = 22050): Float32Array {
  const pcm = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin(i / 8);
  return pcm;
}

function harness(count: number, lookahead = 2) {
  const requested: number[] = [];
  const progress: number[] = [];
  const result: { file: Blob | null; seconds: number; error: string; missing: number[] } = {
    file: null,
    seconds: 0,
    error: '',
    missing: [],
  };
  const exp = new Mp3Export({
    count,
    lookahead,
    request: (id) => requested.push(id),
    leadSilenceSec: (id) => (id === 0 ? 0 : 0.25),
    onProgress: (done) => progress.push(done),
    onDone: (f, s, missing) => {
      result.missing = missing;
      result.file = f;
      result.seconds = s;
    },
    onError: (m) => {
      result.error = m;
    },
  });
  return { exp, requested, progress, result };
}

describe('Mp3Export', () => {
  it('requests a window of sentences ahead, then more as they are encoded', () => {
    const h = harness(6, 2);
    h.exp.start();
    expect(h.requested).toEqual([0, 1, 2]);
    h.exp.accept(0, tone(0.1), 22050);
    expect(h.requested).toEqual([0, 1, 2, 3]);
  });

  it('encodes in order even when audio arrives out of order, including pauses', async () => {
    const h = harness(3, 5);
    h.exp.start();
    h.exp.accept(2, tone(0.5), 22050);
    h.exp.accept(1, tone(0.5), 22050);
    expect(h.progress.at(-1)).toBe(0); // still waiting on sentence 0
    h.exp.accept(0, tone(0.5), 22050);
    expect(h.progress.at(-1)).toBe(3);
    expect(h.result.file).not.toBeNull();
    // 1.5 s of speech + two 0.25 s pauses.
    expect(h.result.seconds).toBeCloseTo(2, 1);
    const bytes = new Uint8Array(await h.result.file!.arrayBuffer());
    expect(bytes[0]).toBe(0xff); // an MPEG audio frame sync
    expect(h.result.file!.type).toBe('audio/mpeg');
  });

  it('turns a sentence that failed into silence instead of stopping, and says which', () => {
    const h = harness(2, 2);
    h.exp.start();
    h.exp.accept(0, tone(0.3), 22050);
    h.exp.accept(1, new Float32Array(0), 22050);
    expect(h.result.file).not.toBeNull();
    expect(h.result.error).toBe('');
    // The audit's A20: a file that is partly silence must not be reported as simply "ready".
    expect(h.result.missing).toEqual([1]);
  });

  it('reports nothing missing when every sentence was spoken', () => {
    const h = harness(2, 2);
    h.exp.start();
    h.exp.accept(0, tone(0.3), 22050);
    h.exp.accept(1, tone(0.3), 22050);
    expect(h.result.missing).toEqual([]);
  });

  it('stops listening once cancelled', () => {
    const h = harness(3, 2);
    h.exp.start();
    h.exp.cancel();
    h.exp.accept(0, tone(0.1), 22050);
    expect(h.progress).toEqual([0]);
    expect(h.result.file).toBeNull();
  });

  it('reports a page with nothing to save', () => {
    const h = harness(0);
    h.exp.start();
    expect(h.result.error).toMatch(/nothing/);
  });
});

describe('audioFileName', () => {
  it('makes a safe file name from a title', () => {
    expect(audioFileName('What: is/this? "A title" | yes')).toBe('What is this A title yes.mp3');
    expect(audioFileName('   ')).toBe('Aloud.mp3');
    const long = audioFileName('First paragraph opens with this sentence here. It closes with this second sentence for testing.');
    expect(long).toBe('First paragraph opens with this sentence here. It closes with this second.mp3');
  });
});
