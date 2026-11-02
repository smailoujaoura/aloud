// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({ fetchModelFile: vi.fn(), cacheHas: vi.fn() }));
vi.mock('@/engine/model-cache', () => cache);
vi.mock('wxt/browser', () => ({ browser: { runtime: { getURL: (p: string) => p } } }));

import { fetchPhononVoices } from '@/entrypoints/options/downloads';

const voices = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe("Phonon's voices downloaded with the model", () => {
  it('four at a time, each checked against its SHA-256 and stored', async () => {
    let running = 0;
    let most = 0;
    const seen: Array<{ url: string; sha256?: string; mustStore?: boolean }> = [];
    cache.fetchModelFile.mockReset().mockImplementation(async (url: string, opts: { sha256?: string; mustStore?: boolean }) => {
      seen.push({ url, sha256: opts.sha256, mustStore: opts.mustStore });
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Uint8Array(10);
    });
    let bytes = 0;
    await fetchPhononVoices(voices, Object.fromEntries(voices.map((v) => [v, `sum-${v}`])), (n) => (bytes += n), new AbortController().signal);
    expect(most).toBe(4);
    expect(bytes).toBe(80);
    expect(seen.map((s) => s.url.split('/').pop()).sort()).toEqual(voices.map((v) => `${v}.safetensors`));
    expect(seen.every((s) => s.mustStore && s.sha256 === `sum-${s.url.split('/').pop()!.replace('.safetensors', '')}`)).toBe(true);
  });

  it('the first failure stops the rest, and is reported once all have stopped', async () => {
    const events: string[] = [];
    cache.fetchModelFile.mockReset().mockImplementation((url: string, opts: { signal: AbortSignal }) => {
      if (url.endsWith('/b.safetensors')) return Promise.reject(new Error('Integrity check failed for b voice'));
      return new Promise((_, reject) =>
        opts.signal.addEventListener('abort', () => setTimeout(() => (events.push('stopped'), reject(new DOMException('aborted', 'AbortError'))), 10)),
      );
    });
    const done = fetchPhononVoices(voices, {}, () => {}, new AbortController().signal).catch((err: Error) => events.push(`failed: ${err.message}`));
    await done;
    expect(events.at(-1)).toBe('failed: Integrity check failed for b voice');
    expect(events.filter((e) => e === 'stopped')).toHaveLength(3);
    expect(cache.fetchModelFile).toHaveBeenCalledTimes(4);
  });
});
