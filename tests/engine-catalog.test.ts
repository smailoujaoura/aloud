import { describe, it, expect } from 'vitest';
import { engineInfo, rankedEngines } from '@/shared/engine-catalog';
import type { BrowserCapabilities } from '@/shared/browser-env';

function caps(over: Partial<BrowserCapabilities> = {}): BrowserCapabilities {
  return {
    engine: 'gecko',
    formFactor: 'desktop',
    workerWebGPU: false,
    contentScriptCanSpawnExtensionWorker: false,
    menusTargetElement: true,
    backgroundIsServiceWorker: false,
    touchFirst: false,
    ...over,
  };
}

const FIREFOX = caps();
const CHROME = caps({
  engine: 'chromium',
  workerWebGPU: true,
  contentScriptCanSpawnExtensionWorker: true,
  menusTargetElement: false,
  backgroundIsServiceWorker: true,
});
const ANDROID = caps({ formFactor: 'android', touchFirst: true });

describe('engineInfo', () => {
  it('recommends Kokoro where a worker can reach the GPU', () => {
    expect(engineInfo('kokoro', CHROME).standing).toBe('recommended');
    expect(engineInfo('kokoro', CHROME).tag).toMatch(/GPU/i);
  });

  it('marks Kokoro slow, but still usable, without a GPU', () => {
    const info = engineInfo('kokoro', FIREFOX);
    expect(info.standing).toBe('slow');
    // The blurb has to say *why*, not just that it is slow — and on Firefox "why" is a setting
    // the user can change, so it must point at that rather than sounding like a dead end.
    expect(info.blurb).toMatch(/Firefox has WebGPU switched off for workers/);
    expect(info.blurb).toMatch(/settings page/);
  });

  it('treats Firefox with WebGPU switched on exactly like any other GPU machine', () => {
    // Turning on dom.webgpu.enabled + dom.webgpu.workers.enabled really does give an extension
    // worker an adapter, so nothing here may key off the browser name: a measured
    // `workerWebGPU` is the whole input.
    const firefoxWithGpu = caps({ workerWebGPU: true });
    expect(engineInfo('kokoro', firefoxWithGpu).standing).toBe('recommended');
    expect(engineInfo('kokoro', firefoxWithGpu).tag).toMatch(/GPU/i);
    expect(engineInfo('piper', firefoxWithGpu).standing).toBe('good');
    expect(rankedEngines(firefoxWithGpu)[0]?.id).toBe('kokoro');
  });

  it('rules the neural engines out on phones', () => {
    expect(engineInfo('kokoro', ANDROID).standing).toBe('unsuitable');
    expect(engineInfo('supertonic', ANDROID).standing).toBe('unsuitable');
  });

  it('makes Piper the recommendation wherever the neural engines are not viable', () => {
    expect(engineInfo('piper', FIREFOX).standing).toBe('recommended');
    expect(engineInfo('piper', ANDROID).standing).toBe('recommended');
    // On Chromium Piper is still good, just no longer the best available.
    expect(engineInfo('piper', CHROME).standing).toBe('good');
  });

  it('carries the cache hint only for the shared-model engines', () => {
    expect(engineInfo('piper', FIREFOX).cacheHint).toBeUndefined();
    expect(engineInfo('kokoro', FIREFOX).cacheHint).toBe('Kokoro-82M');
    expect(engineInfo('supertonic', FIREFOX).cacheHint).toBe('supertonic-2');
  });
});

describe('rankedEngines', () => {
  it('puts the best-supported engine for the browser first', () => {
    expect(rankedEngines(CHROME)[0]?.id).toBe('kokoro');
    expect(rankedEngines(FIREFOX)[0]?.id).toBe('piper');
    expect(rankedEngines(ANDROID)[0]?.id).toBe('piper');
  });

  it('sinks engines that cannot run on the device to the bottom', () => {
    const order = rankedEngines(ANDROID).map((e) => e.id);
    expect(order[0]).toBe('piper');
    expect(order.slice(1).sort()).toEqual(['kokoro', 'supertonic']);
  });

  it('always lists every engine exactly once', () => {
    for (const c of [FIREFOX, CHROME, ANDROID]) {
      expect(rankedEngines(c).map((e) => e.id).sort()).toEqual(['kokoro', 'piper', 'supertonic']);
    }
  });
});
