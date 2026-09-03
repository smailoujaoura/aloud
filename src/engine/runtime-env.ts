/**
 * Runtime environment setup for the synthesis worker.
 *
 * The worker is loaded from `<scheme>-extension://<id>/tts-worker.js` (`moz-` on Firefox,
 * `chrome-` on Chromium), so extension-packaged assets resolve relative to `self.location`.
 * `browser.*` APIs are NOT available in a Web Worker, so we never call `runtime.getURL` here.
 *
 * Whether the GPU is reachable is the single biggest performance fact about this worker, so the
 * probe below reports its result — and, when it fails, *why* — rather than silently falling back.
 */
import { capabilities } from '@/shared/browser-env';

/** Absolute URL of a packaged asset, e.g. assetUrl('vendor/ort/') -> moz-extension://<id>/vendor/ort/ */
export function assetUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), self.location.href).href;
}

let webgpuChecked = false;
let webgpuAvailable = false;

export async function detectWebGPU(): Promise<boolean> {
  if (webgpuChecked) return webgpuAvailable;
  webgpuChecked = true;
  try {
    const gpu = (
      navigator as unknown as {
        gpu?: {
          requestAdapter(o?: unknown): Promise<{
            features?: Iterable<string>;
            info?: Record<string, unknown>;
            requestAdapterInfo?: () => Promise<Record<string, unknown>>;
          } | null>;
        };
      }
    ).gpu;
    if (!gpu) {
      // Expected on Firefox (extension workers get no `navigator.gpu` yet) and on Android;
      // surprising anywhere else, so name the browser rather than leaving it a mystery.
      const why =
        capabilities().engine === 'gecko'
          ? 'Firefox does not expose it to extension workers yet'
          : 'this worker has no GPU access';
      // eslint-disable-next-line no-console
      console.info(`[aloud] WebGPU: navigator.gpu is not present — ${why}. Using WASM.`);
      return (webgpuAvailable = false);
    }
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    webgpuAvailable = !!adapter;
    let detail = '';
    try {
      const info = adapter?.info ?? (await adapter?.requestAdapterInfo?.());
      const feats = adapter?.features ? [...adapter.features] : [];
      detail = ` (${JSON.stringify(info ?? {})}, shader-f16=${feats.includes('shader-f16')})`;
    } catch {
      /* info is best-effort */
    }
    // eslint-disable-next-line no-console
    console.info(`[aloud] WebGPU adapter ${adapter ? 'acquired' : 'NOT available'}${detail}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.info(`[aloud] WebGPU probe threw — using WASM: ${String(err)}`);
    webgpuAvailable = false;
  }
  return webgpuAvailable;
}

export async function chooseExecutionProviders(preferWebGPU: boolean): Promise<Array<'webgpu' | 'wasm'>> {
  if (preferWebGPU && (await detectWebGPU())) return ['webgpu', 'wasm'];
  return ['wasm'];
}
