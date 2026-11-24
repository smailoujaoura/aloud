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

describe('which browser, and what kind of device', () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const as = (userAgent: string, maxTouchPoints = 0): BrowserCapabilities => {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent, maxTouchPoints }, configurable: true });
    __setCapabilitiesForTest(null);
    return capabilities();
  };
  afterEach(() => {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  });

  it('Safari on a Mac is WebKit on a computer', () => {
    const mac = as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15');
    expect(mac).toMatchObject({ engine: 'webkit', formFactor: 'desktop', touchFirst: false, backgroundIsServiceWorker: true, workerWebGPU: false });
  });

  it('an iPhone is a phone: at most two voices loaded at once, the speed button on the video', () => {
    const phone = as('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
    expect(phone).toMatchObject({ engine: 'webkit', formFactor: 'ios', touchFirst: true });
  });

  it('an iPad calling itself a Mac is told by its touch screen', () => {
    const ipad = as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 5);
    expect(ipad).toMatchObject({ engine: 'webkit', formFactor: 'ios', touchFirst: true });
  });

  it('Chrome and Firefox are who they were, Chrome on a Mac included (its name has Safari in it)', () => {
    expect(as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36')).toMatchObject({ engine: 'chromium', formFactor: 'desktop', touchFirst: false });
    expect(as('Mozilla/5.0 (Android 15; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0')).toMatchObject({ engine: 'gecko', formFactor: 'android', touchFirst: true });
    expect(as('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0')).toMatchObject({ engine: 'gecko', formFactor: 'desktop', touchFirst: false });
  });
});
