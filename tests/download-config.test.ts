import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

const { engineConfigFor } = await import('@/entrypoints/options/engine-config');
const { DEFAULT_SETTINGS } = await import('@/shared/settings');
const { downloadSize, engineInfo } = await import('@/shared/engine-catalog');
const { humanBytes } = await import('@/shared/log');

describe('what a Download fetches', () => {
  it('fetches the Kokoro build this machine reads with: the GPU one when reading on the GPU', () => {
    // Fetching the CPU build there downloaded a file reading never used, and the first preview
    // then downloaded the full-precision build anyway.
    expect(engineConfigFor({ ...DEFAULT_SETTINGS, preferWebGPU: true }, { engine: 'kokoro', purpose: 'download' }).preferWebGPU).toBe(true);
    expect(engineConfigFor({ ...DEFAULT_SETTINGS, preferWebGPU: false }, { engine: 'kokoro', purpose: 'download' }).preferWebGPU).toBe(false);
  });

  it('states the size of the file this machine downloads, in the units the browser shows', () => {
    // The weights and all 41 voices' own files, which come in the same download.
    expect(downloadSize(engineInfo('kokoro'), true)).toBe('~347 MB');
    expect(downloadSize(engineInfo('kokoro'), false)).toBe('~114 MB');
    expect(downloadSize(engineInfo('supertonic'), true)).toBe(engineInfo('supertonic').approxSize);
    // Firefox showed Kokoro's GPU file as 325.53 MB; counting in 1024s said 310.
    expect(humanBytes(325_532_232)).toBe('326 MB');
  });

  it('keeps Supertonic, whose files are the same either way, off the GPU', () => {
    expect(engineConfigFor({ ...DEFAULT_SETTINGS, preferWebGPU: true }, { engine: 'supertonic', purpose: 'download' }).preferWebGPU).toBe(false);
  });
});
