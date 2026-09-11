import { describe, it, expect, afterEach } from 'vitest';
import {
  __setCapabilitiesForTest,
  applyWorkerGpuProbe,
  capabilities,
  capabilitiesWithGpu,
  type BrowserCapabilities,
} from '@/shared/browser-env';

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

afterEach(() => __setCapabilitiesForTest(null));

describe('GPU capability', () => {
  it('lets a document-side probe take the GPU away, never grant it', () => {
    // Chromium claims `navigator.gpu` on machines that then refuse an adapter.
    const chrome = caps({ engine: 'chromium', workerWebGPU: true });
    expect(capabilitiesWithGpu({ available: false }, chrome).workerWebGPU).toBe(false);

    // And a Firefox *page* with WebGPU says nothing about its workers, which is where synthesis
    // runs — Firefox gates the two with separate prefs.
    expect(capabilitiesWithGpu({ available: true }, caps()).workerWebGPU).toBe(false);
  });

  it('leaves the expectation alone while no probe has finished', () => {
    const chrome = caps({ engine: 'chromium', workerWebGPU: true });
    expect(capabilitiesWithGpu(null, chrome).workerWebGPU).toBe(true);
  });

  it('lets a worker-measured probe grant the GPU on Firefox', () => {
    // The case this exists for: a user turned on dom.webgpu.workers.enabled, and a real
    // synthesis worker then reported an adapter. That is the answer, not an upper bound.
    __setCapabilitiesForTest(caps());
    expect(capabilities().workerWebGPU).toBe(false);
    expect(applyWorkerGpuProbe(true).workerWebGPU).toBe(true);
    expect(capabilities().workerWebGPU).toBe(true);
  });

  it('lets a worker-measured probe take the GPU away again', () => {
    __setCapabilitiesForTest(caps({ engine: 'chromium', workerWebGPU: true }));
    expect(applyWorkerGpuProbe(false).workerWebGPU).toBe(false);
  });
});
