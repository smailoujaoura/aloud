import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Every synthesis host created, with what it was asked. */
const hosts: FakeClient[] = [];

class FakeClient {
  config: { engine: string; voice: string; workers?: number } | null = null;
  requests: Array<{ playId: number; text: string; voice?: string }> = [];
  disposed = false;
  private resolveInit: (() => void) | null = null;
  private rejectInit: ((e: Error) => void) | null = null;
  constructor(public cb: { onAudio(id: number, pcm: Float32Array, sr: number): void; onError(i: unknown): void }) {
    hosts.push(this);
  }
  init(config: FakeClient['config']): Promise<void> {
    this.config = config;
    return new Promise((ok, no) => {
      this.resolveInit = ok;
      this.rejectInit = no;
    });
  }
  /** As the real client does: `onReady` first, inside the message handler; then `init` resolves. */
  ready(): void {
    (this.cb as { onReady?(i: unknown): void }).onReady?.({ sampleRate: 24000, executionProvider: 'wasm' });
    this.resolveInit?.();
  }
  fail(message: string): void {
    this.rejectInit?.(new Error(message));
  }
  request(playId: number, text: string, _speed: number, voice?: string): void {
    this.requests.push({ playId, text, voice });
  }
  forget(): void {}
  cancelFrom(): void {}
  dispose(): void {
    this.disposed = true;
  }
  /** The engine answers. */
  say(playId: number): void {
    this.cb.onAudio(playId, new Float32Array([0.1]), 22050);
  }
}

vi.mock('@/engine/worker-client', () => ({ WorkerClient: FakeClient }));
const { VoiceLanes, MAX_LANES } = await import('@/content/voice-lanes');

const flush = () => new Promise((r) => setTimeout(r, 0));
const base = { preferWebGPU: false, speed: 1, workers: 4 };

function setup() {
  const audio: Array<[number, string]> = [];
  const failed: Array<{ voice: string; ids: number[] }> = [];
  const closed: number[][] = [];
  const lanes = new VoiceLanes({
    onReady: () => undefined,
    onProgress: () => undefined,
    onError: () => undefined,
    onAudio: (id) => audio.push([id, 'heard']),
    onLaneFailed: (voice, _m, ids) => failed.push({ voice: voice.voice, ids }),
  });
  return { lanes, audio, failed, closed };
}

beforeEach(() => {
  hosts.length = 0;
});

describe('VoiceLanes', () => {
  it('reads another language beside the main voice, on a second model with few workers', async () => {
    const { lanes, audio } = setup();
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en_GB-alba-medium' });
    hosts[0]!.ready();
    await init;
    lanes.request(0, 'Hello.', 1);
    lanes.request(1, 'Ciao.', 1, { engine: 'piper', voice: 'it_IT-paola-medium' });
    expect(hosts).toHaveLength(2);
    expect(hosts[1]!.config).toMatchObject({ engine: 'piper', voice: 'it_IT-paola-medium', workers: 1 });
    // Asked before the second model was ready: held, then sent.
    expect(hosts[1]!.requests).toHaveLength(0);
    hosts[1]!.ready();
    await flush();
    expect(hosts[1]!.requests.map((r) => r.playId)).toEqual([1]);
    hosts[1]!.say(1);
    hosts[0]!.say(0);
    expect(audio.map(([id]) => id)).toEqual([1, 0]);
  });

  it('sentences asked for inside the main voice’s onReady are sent, not held', async () => {
    const hostsBefore = hosts.length;
    let lanes!: InstanceType<typeof VoiceLanes>;
    lanes = new VoiceLanes({
      onReady: () => lanes.request(0, 'Hello.', 1),
      onProgress: () => undefined,
      onError: () => undefined,
      onAudio: () => undefined,
    });
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[hostsBefore]!.ready();
    await init;
    expect(hosts[hostsBefore]!.requests.map((r) => r.playId)).toEqual([0]);
  });

  it('every Kokoro voice is one model, and every Kokoro request names its voice', async () => {
    const { lanes } = setup();
    const init = lanes.init({ ...base, engine: 'kokoro', voice: 'af_heart' });
    hosts[0]!.ready();
    await init;
    lanes.request(0, 'Hello.', 1);
    lanes.request(1, 'Ciao.', 1, { engine: 'kokoro', voice: 'if_sara' });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.requests.map((r) => r.voice)).toEqual(['af_heart', 'if_sara']);
  });

  it('drops audio from a voice the sentence was taken away from', async () => {
    const { lanes, audio } = setup();
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en_GB-alba-medium' });
    hosts[0]!.ready();
    await init;
    lanes.request(3, 'Ciao.', 1); // read as English at first…
    lanes.request(3, 'Ciao.', 1, { engine: 'piper', voice: 'it_IT-paola-medium' }); // …corrected to Italian
    hosts[0]!.say(3); // the English answer arrives late
    expect(audio).toHaveLength(0);
    hosts[1]!.ready();
    await flush();
    hosts[1]!.say(3);
    expect(audio).toEqual([[3, 'heard']]);
  });

  it('a fourth voice waits for a lane to finish what it owes; no busy lane is closed, never more than MAX_LANES', async () => {
    const { lanes, closed } = setup();
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[0]!.ready();
    await init;
    lanes.request(1, 'a', 1, { engine: 'piper', voice: 'it' });
    lanes.request(2, 'b', 1, { engine: 'piper', voice: 'fr' });
    lanes.request(3, 'c', 1, { engine: 'piper', voice: 'de' });
    expect(lanes.laneCount).toBe(MAX_LANES);
    expect(hosts).toHaveLength(3); // no fourth model while the others owe audio
    expect(hosts.some((h) => h.disposed)).toBe(false);
    expect(lanes.isPending(3)).toBe(true);
    expect(closed).toEqual([]);
    hosts[1]!.ready();
    await flush();
    hosts[1]!.say(1); // Italian has delivered everything it owed…
    expect(hosts[1]!.disposed).toBe(true); // …so it makes room
    expect(hosts).toHaveLength(4);
    expect(lanes.laneCount).toBe(MAX_LANES);
    hosts[3]!.ready();
    await flush();
    expect(hosts[3]!.requests.map((r) => r.playId)).toEqual([3]);
  });

  it('an MP3 export with four voices finishes, whatever order the audio comes back in', async () => {
    const { Mp3Export } = await import('@/content/audio-export');
    let exp!: InstanceType<typeof Mp3Export>;
    let done = false;
    const voices = ['en', 'it', 'fr', 'de', 'it', 'es'];
    const lanes = new VoiceLanes({
      onReady: () => undefined,
      onProgress: () => undefined,
      onError: () => undefined,
      onAudio: (id, pcm, sr) => exp.accept(id, pcm, sr),
    });
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[0]!.ready();
    await init;
    exp = new Mp3Export({
      count: voices.length,
      lookahead: 6,
      request: (id) => lanes.request(id, 'Text to read.', 1, { engine: 'piper', voice: voices[id]! }),
      leadSilenceSec: () => 0,
      onProgress: () => undefined,
      onDone: () => (done = true),
      onError: () => undefined,
    });
    exp.start();
    // Hosts answer in rounds, newest first: every live host that is ready answers what it owes.
    const answered = new Set<string>();
    for (let round = 0; round < 20 && !done; round++) {
      for (const h of [...hosts].reverse()) {
        if (h.disposed) continue;
        h.ready();
        await flush();
        for (const r of h.requests) {
          const k = `${hosts.indexOf(h)}:${r.playId}`;
          if (answered.has(k)) continue;
          answered.add(k);
          (h.cb as { onAudio(i: number, p: Float32Array, s: number): void }).onAudio(r.playId, new Float32Array(2205).fill(0.1), 22050);
        }
      }
      expect(hosts.filter((h) => !h.disposed).length).toBeLessThanOrEqual(MAX_LANES);
    }
    expect(done).toBe(true);
  });

  it('a secondary voice that fails after loading is reported, with what it owed', async () => {
    const { lanes, failed } = setup();
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[0]!.ready();
    await init;
    lanes.request(1, 'Bonjour.', 1, { engine: 'piper', voice: 'fr' });
    hosts[1]!.ready();
    await flush();
    (hosts[1]!.cb as { onError(i: unknown): void }).onError({ fatal: true, message: 'The voice stopped working and could not be restarted' });
    expect(failed).toEqual([{ voice: 'fr', ids: [1] }]);
    expect(lanes.isPending(1)).toBe(false);
    expect(hosts[1]!.disposed).toBe(true);
    expect(lanes.usable({ engine: 'piper', voice: 'fr' })).toBe(false);
  });

  it('a phone keeps one voice beside the main one: a third waits rather than loading', async () => {
    const lanes = new VoiceLanes({ onReady: () => undefined, onProgress: () => undefined, onError: () => undefined, onAudio: () => undefined }, { maxLanes: 2 });
    const before = hosts.length;
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[before]!.ready();
    await init;
    lanes.request(1, 'a', 1, { engine: 'piper', voice: 'it' });
    lanes.request(2, 'b', 1, { engine: 'piper', voice: 'fr' });
    expect(lanes.laneCount).toBe(2);
    expect(hosts.length - before).toBe(2);
    expect(lanes.isPending(2)).toBe(true);
    // Every extra voice runs one worker, whatever the main pool runs.
    expect(hosts[before + 1]!.config).toMatchObject({ workers: 1 });
  });

  it('a voice that cannot load is reported with what it owed, and not tried again', async () => {
    const { lanes, failed } = setup();
    const init = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[0]!.ready();
    await init;
    lanes.request(5, 'a', 1, { engine: 'piper', voice: 'it' });
    hosts[1]!.fail('404');
    await flush();
    expect(failed).toEqual([{ voice: 'it', ids: [5] }]);
    expect(lanes.usable({ engine: 'piper', voice: 'it' })).toBe(false);
    lanes.request(6, 'b', 1, { engine: 'piper', voice: 'it' });
    expect(hosts).toHaveLength(2);
  });

  it('a new main voice closes every other model', async () => {
    const { lanes } = setup();
    const first = lanes.init({ ...base, engine: 'piper', voice: 'en' });
    hosts[0]!.ready();
    await first;
    lanes.request(1, 'a', 1, { engine: 'piper', voice: 'it' });
    const second = lanes.init({ ...base, engine: 'piper', voice: 'fr' });
    expect(hosts[1]!.disposed).toBe(true);
    expect(hosts[0]!.disposed).toBe(true);
    hosts[2]!.ready();
    await second;
    expect(lanes.laneCount).toBe(1);
  });
});
