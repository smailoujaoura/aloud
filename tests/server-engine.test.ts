import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeWav } from '@/audio/wav-decode';
import { serverAddressProblem, serverBase, serverOrigin, serverVoiceLanguage, speechUrl, voicesFrom } from '@/shared/server-voices';
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

describe('a server on the internet, and its key', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('plain http only on this machine or your own network', () => {
    for (const host of ['localhost', 'pc', '127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '169.254.3.4', '100.101.102.103', 'gpu-box.tail1234.ts.net', 'nas.local', 'pc.lan', '[::1]', '[fd12:3456::1]']) {
      expect(serverAddressProblem(`http://${host}:8880/v1`), host).toBeNull();
    }
    for (const host of ['tts.example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '[2001:db8::1]']) {
      expect(serverAddressProblem(`http://${host}:8880/v1`), host).toMatch(/only talks to it over https/);
    }
    expect(serverAddressProblem('https://tts.example.com/v1')).toBeNull();
  });

  it('sends the key as a Bearer token, to both addresses it uses', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return url.endsWith('/voices') ? new Response('{"voices":["af_heart"]}') : new Response(wav([0, 0.1]));
    });
    const engine = new ServerEngine('https://tts.example.com/v1', 'kokoro', 's3cret');
    await engine.init({ voice: 'af_heart' } as never);
    await engine.synthesize('Hello.', 1, 'af_heart');
    expect(seen).toEqual([
      { url: 'https://tts.example.com/v1/audio/voices', auth: 'Bearer s3cret' },
      { url: 'https://tts.example.com/v1/audio/speech', auth: 'Bearer s3cret' },
    ]);
  });

  it('no key, no Authorization header', async () => {
    let auth: string | null = 'unset';
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => ((auth = new Headers(init?.headers).get('authorization')), new Response('{"voices":[]}')));
    await new ServerEngine('http://localhost:8880/v1', '').init({ voice: 'x' } as never);
    expect(auth).toBeNull();
  });

  it('says plainly when the key is refused or missing, and never reaches a plain-http internet address', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    await expect(new ServerEngine('https://tts.example.com/v1', '', 'wrong').init({ voice: 'x' } as never)).rejects.toThrow(/refused the key/);
    await expect(new ServerEngine('https://tts.example.com/v1', '').init({ voice: 'x' } as never)).rejects.toThrow(/asks for a key/);
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    await expect(new ServerEngine('http://tts.example.com/v1', '', 'k').init({ voice: 'x' } as never)).rejects.toThrow(/https/);
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('a server address from storage or a backup file', () => {
  it('is kept as Connect would save it, or dropped', async () => {
    const { sanitizeSettings, withDefaults } = await import('@/shared/settings');
    const restored = (server: unknown) => sanitizeSettings(withDefaults({ server } as never)).server;
    expect(restored({ url: 'http://localhost:8880/v1/audio/speech', model: 'kokoro', voices: ['af_heart'] })).toEqual({ url: 'http://localhost:8880/v1', model: 'kokoro', voices: ['af_heart'] });
    expect(restored({ url: 'javascript:alert(1)', model: 'x', voices: ['a'] })).toEqual({ url: '', model: '', voices: [] });
    expect(restored({ url: 42 }).url).toBe('');
  });
});

describe("a server that reads at one speed only (Gradium's Phonon server)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** What ptts-openai-server 0.6.0 answers (src/api.rs): a 400 naming `speed`, and a WAV streamed without its length. */
  const phononServer = () => {
    const asked: number[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const { speed } = JSON.parse(String(init?.body)) as { speed: number };
      asked.push(speed);
      if (speed !== 1) {
        const message = `speed ${speed} is not supported: this model has no rate control yet; omit speed, send 1.0, or start the server with --ignore-speed to speak at the normal rate`;
        return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', param: 'speed', code: null } }), { status: 400 });
      }
      const audio = wav(Array.from({ length: 24000 }, (_, i) => 0.3 * Math.sin(i / 10)));
      new DataView(audio).setUint32(4, 0xffffffff, true); // streamed: no length, in either header
      new DataView(audio).setUint32(40, 0xffffffff, true);
      return new Response(audio);
    });
    return asked;
  };

  it('asks again at 1×, speeds this sentence up itself, and reads at 1× from then on', async () => {
    const asked = phononServer();
    const engine = new ServerEngine('https://tts.example.com/v1', '', 'k');
    expect(engine.fixedSpeed).toBe(false);
    const first = await engine.synthesize('Hello there.', 1.25, 'default');
    expect(asked).toEqual([1.25, 1]);
    expect(first.pcm.length).toBe(Math.round(24000 / 1.25));
    expect(engine.fixedSpeed).toBe(true);
    // The worker now asks for 1× and stretches (splitSpeed with fixedSpeed): one request each.
    await engine.synthesize('And again.', 1, 'default');
    expect(asked).toEqual([1.25, 1, 1]);
  });

  it('other refusals are still errors, said as the server said them', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'voice alloy is not a voice of this server', param: 'voice' } }), { status: 400 }));
    const engine = new ServerEngine('https://tts.example.com/v1', '', 'k');
    await expect(engine.synthesize('Hi.', 1.25, 'alloy')).rejects.toThrow(/400: .*voice alloy/);
    expect(engine.fixedSpeed).toBe(false);
  });
});
