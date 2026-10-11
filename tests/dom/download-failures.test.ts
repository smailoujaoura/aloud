// @vitest-environment happy-dom
/**
 * The failure paths of a voice download, which the checked-in tests had not covered:
 * one file failing while the other is still on its way, and a download that could not be saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({
  fetchModelFile: vi.fn(),
  cacheHas: vi.fn(),
}));
vi.mock('@/engine/model-cache', () => cache);
vi.mock('wxt/browser', () => ({ browser: { runtime: { getURL: (p: string) => p } } }));

import { downloadPiperVoice } from '@/entrypoints/options/downloads';
import { DownloadQueue } from '@/entrypoints/options/download-queue';

const entry = { config: 'https://hf.test/alba.onnx.json', onnx: 'https://hf.test/alba.onnx', sizeBytes: 100 } as never;
const sink = { set: () => {}, note: () => {} };

describe('a voice download that goes wrong', () => {
  beforeEach(() => {
    cache.fetchModelFile.mockReset();
    cache.cacheHas.mockReset().mockResolvedValue(true);
  });

  it('AF01: one file failing cancels the other, and the job ends only when both have stopped', async () => {
    const events: string[] = [];
    cache.fetchModelFile.mockImplementation((url: string, opts: { signal: AbortSignal; mustStore: boolean }) => {
      expect(opts.mustStore).toBe(true);
      if (url.endsWith('.json')) {
        return Promise.reject(new Error('Download failed (503) for config'));
      }
      // The voice file is still streaming: it stops only when it is told to.
      return new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
          setTimeout(() => {
            events.push('voice stopped');
            reject(new DOMException('aborted', 'AbortError'));
          }, 20);
        });
      });
    });

    const q = new DownloadQueue();
    const next = vi.fn(() => Promise.resolve());
    const alba = q.enqueue('piper:alba', 'Alba', (p) => downloadPiperVoice(entry, p)).catch((err: Error) => {
      events.push(`alba failed: ${err.message}`);
    });
    void q.enqueue('piper:ryan', 'Ryan', async () => {
      events.push('ryan started');
      await next();
    });
    await alba;
    await new Promise((r) => setTimeout(r, 0));

    // The voice file had stopped before the failure was reported and before Ryan began; and the
    // failure reported is the cause, not the cancellation.
    expect(events[0]).toBe('voice stopped');
    expect(events.slice(1).sort()).toEqual(['alba failed: Download failed (503) for config', 'ryan started']);
  });

  it('AF02: a download whose files did not reach the cache is a failure, not "ready"', async () => {
    cache.fetchModelFile.mockResolvedValue(new Uint8Array(4));
    cache.cacheHas.mockResolvedValue(false);
    await expect(downloadPiperVoice(entry, sink)).rejects.toThrow(/could not be saved on this device/);
  });

  it('a download that did reach the cache is ready', async () => {
    cache.fetchModelFile.mockResolvedValue(new Uint8Array(4));
    await expect(downloadPiperVoice(entry, sink)).resolves.toBeUndefined();
  });
});

describe('rows that are gone stop listening', () => {
  it('AE01: a redraw ends the old rows’ subscriptions at once, queue idle or not', () => {
    const q = new DownloadQueue();
    const scope = new AbortController();
    for (let i = 0; i < 50; i++) q.subscribe(() => {}, scope.signal);
    expect(q.listenerCount).toBe(50);
    scope.abort();
    expect(q.listenerCount).toBe(0);
    q.subscribe(() => {}, scope.signal); // already ended: never added
    expect(q.listenerCount).toBe(0);
  });
});
