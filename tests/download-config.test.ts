import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

const { engineConfigFor } = await import('@/entrypoints/options/engine-config');
const { DEFAULT_SETTINGS } = await import('@/shared/settings');
const { engineInfo } = await import('@/shared/engine-catalog');

describe('what a Download fetches', () => {
  it('fetches the Kokoro build this machine reads with: the GPU one when reading on the GPU', () => {
    // Fetching the CPU build there downloaded a file reading never used, and the first preview
    // then downloaded the full-precision build anyway.
    expect(engineConfigFor({ ...DEFAULT_SETTINGS, preferWebGPU: true }, { engine: 'kokoro', purpose: 'download' }).preferWebGPU).toBe(true);
    expect(engineConfigFor({ ...DEFAULT_SETTINGS, preferWebGPU: false }, { engine: 'kokoro', purpose: 'download' }).preferWebGPU).toBe(false);
  });

  it('keeps Supertonic, whose files are the same either way, off the GPU', () => {
    expect(engineConfigFor({ ...DEFAULT_SETTINGS, preferWebGPU: true }, { engine: 'supertonic', purpose: 'download' }).preferWebGPU).toBe(false);
  });

  it('states the GPU build’s size for Kokoro only', () => {
    expect(engineInfo('kokoro').gpuApproxSize).toBeTruthy();
    expect(engineInfo('supertonic').gpuApproxSize).toBeUndefined();
    expect(engineInfo('piper').gpuApproxSize).toBeUndefined();
  });
});
