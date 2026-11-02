import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeWav } from '@/audio/wav-decode';
import { serverBase, serverOrigin, serverVoiceLanguage, speechUrl, voicesFrom } from '@/shared/server-voices';
import { ServerEngine } from '@/engine/engines/server';

/** A WAV file of `samples`, as a speech server sends it. */
function wav(samples: number[], { rate = 24000, channels = 1, float = false } = {}): ArrayBuffer {
  const bytes = float ? 4 : 2;
  const data = samples.length * bytes;
  const b = new DataView(new ArrayBuffer(44 + data));
  const put = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF'); b.setUint32(4, 36 + data, true); put(8, 'WAVE'); put(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, float ? 3 : 1, true); b.setUint16(22, channels, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * channels * bytes, true); b.setUint16(32, channels * bytes, true);
  b.setUint16(34, bytes * 8, true); put(36, 'data'); b.setUint32(40, data, true);
  samples.forEach((s, i) => (float ? b.setFloat32(44 + i * 4, s, true) : b.setInt16(44 + i * 2, Math.round(s * 32767), true)));
  return b.buffer;
}

describe('a WAV from a speech server', () => {
  it('16-bit mono, with its sample rate', () => {
    const { pcm, sampleRate } = decodeWav(wav([0, 0.5, -0.5], { rate: 22050 }));
    expect(sampleRate).toBe(22050);
    expect([...pcm].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5]);
  });

  it('32-bit float, and stereo averaged to mono', () => {
    expect([...decodeWav(wav([0.25, -0.25], { float: true })).pcm]).toEqual([0.25, -0.25]);
    expect([...decodeWav(wav([0.5, 0.25, 0, 0], { channels: 2, float: true })).pcm]).toEqual([0.375, 0]);
  });

  it('refuses what is not a WAV (an MP3, an error page)', () => {
    expect(() => decodeWav(new TextEncoder().encode('<html>502 Bad Gateway</html>').buffer)).toThrow(/not a WAV/);
  });
});

describe('the server address (#9)', () => {
  it('is tidied: trailing slashes and a pasted /audio/speech go', () => {
    expect(serverBase('http://localhost:8880/v1/')).toBe('http://localhost:8880/v1');
    expect(serverBase(' http://pc.tailnet:8880/v1/audio/speech ')).toBe('http://pc.tailnet:8880/v1');
    expect(serverBase('ftp://x')).toBe('');
    expect(serverBase('not an address')).toBe('');
    expect(speechUrl('http://localhost:8880/v1')).toBe('http://localhost:8880/v1/audio/speech');
  });

  it('asks permission for that host only, on any port', () => {
    expect(serverOrigin('http://localhost:8880/v1')).toBe('http://localhost/*');
    expect(serverOrigin('https://tts.example.ts.net/v1')).toBe('https://tts.example.ts.net/*');
  });

  it("reads a voice list either way servers send it, and Kokoro names' languages", () => {
    expect(voicesFrom({ voices: ['af_heart', 'ff_siwis'] })).toEqual(['af_heart', 'ff_siwis']);
    expect(voicesFrom([{ id: 'alloy' }, { name: 'nova' }, 'alloy'])).toEqual(['alloy', 'nova']);
    expect(voicesFrom({ error: 'nope' })).toEqual([]);
    expect(serverVoiceLanguage('ff_siwis')).toBe('fr');
    expect(serverVoiceLanguage('bm_george')).toBe('en-GB');
    expect(serverVoiceLanguage('alloy')).toBe('en');
  });
});

describe('ServerEngine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the text, voice and speed, and plays the WAV that comes back', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith('/audio/voices') ? new Response('{"voices":["af_heart"]}') : new Response(wav([0.1, 0.2], { rate: 24000 })),
    );
    vi.stubGlobal('fetch', fetch);
    const engine = new ServerEngine('http://localhost:8880/v1', 'kokoro');
    await engine.init({ voice: 'af_heart', preferWebGPU: false, onProgress: () => {} });
    const out = await engine.synthesize('Hello there.', 1.5);
    expect(out.sampleRate).toBe(24000);
    expect(out.pcm.length).toBe(2);
    const [url, init] = fetch.mock.calls.at(-1)!;
    expect(url).toBe('http://localhost:8880/v1/audio/speech');
    expect(JSON.parse(init!.body as string)).toEqual({ model: 'kokoro', input: 'Hello there.', voice: 'af_heart', speed: 1.5, response_format: 'wav' });
  });

  it('says clearly when the server is down or refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(new ServerEngine('http://localhost:8880/v1', '').init({ voice: 'x', preferWebGPU: false, onProgress: () => {} })).rejects.toThrow(/Can't reach the speech server/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"Voice nope not found"}', { status: 400 })));
    await expect(new ServerEngine('http://localhost:8880/v1', '').synthesize('Hi.', 1, 'nope')).rejects.toThrow(/400.*Voice nope not found/);
    await expect(new ServerEngine('', '').init({ voice: 'x', preferWebGPU: false, onProgress: () => {} })).rejects.toThrow(/No server address/);
  });
});
