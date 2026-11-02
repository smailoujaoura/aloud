import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = new Map<string, unknown>();
vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: (key: string, opts: { fallback: unknown }) => ({
      getValue: async () => (stored.has(key) ? structuredClone(stored.get(key)) : opts.fallback),
      setValue: async (v: unknown) => void stored.set(key, structuredClone(v)),
      removeValue: async () => void stored.delete(key),
    }),
  },
}));
const { getServerKey, keyFor, setServerKey, withServerKey } = await import('@/shared/server-key');

describe('the key for your own server goes to that server only', () => {
  beforeEach(() => stored.clear());

  it('is handed out for the address it was given for', async () => {
    await setServerKey('s3cret', 'https://tts.example.com/v1');
    expect(await getServerKey('https://tts.example.com/v1')).toBe('s3cret');
    expect(await getServerKey('https://tts.example.com/other/path')).toBe('s3cret');
  });

  it('never for another host, port or scheme (a moved server, a restored backup)', async () => {
    await setServerKey('s3cret', 'https://tts.example.com/v1');
    expect(await getServerKey('https://evil.example.net/v1')).toBe('');
    expect(await getServerKey('https://tts.example.com:8443/v1')).toBe('');
    expect(await getServerKey('http://tts.example.com/v1')).toBe('');
    const config = { engine: 'server' as const, voice: 'af_heart', speed: 1, preferWebGPU: false, server: { url: 'https://evil.example.net/v1', model: '' } };
    expect((await withServerKey(config as never)).server).toEqual({ url: 'https://evil.example.net/v1', model: '' });
  });

  it('is added to its own server’s config, and empty removes it', async () => {
    await setServerKey('s3cret', 'http://192.168.1.10:8880/v1');
    const config = { engine: 'server' as const, voice: 'af_heart', speed: 1, preferWebGPU: false, server: { url: 'http://192.168.1.10:8880/v1', model: 'kokoro' } };
    expect((await withServerKey(config as never)).server?.key).toBe('s3cret');
    await setServerKey('', 'http://192.168.1.10:8880/v1');
    expect(stored.size).toBe(0);
  });

  it('what the synthesis host reads raw is checked the same way', () => {
    expect(keyFor({ origin: 'https://tts.example.com', key: 'k' }, 'https://tts.example.com/v1')).toBe('k');
    expect(keyFor({ origin: 'https://tts.example.com', key: 'k' }, 'https://other.example/v1')).toBe('');
    expect(keyFor('a bare string', 'https://tts.example.com/v1')).toBe('');
    expect(keyFor(null, 'https://tts.example.com/v1')).toBe('');
  });
});
