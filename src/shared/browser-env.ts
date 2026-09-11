/**
 * Which browser are we running in, and what can it actually do?
 *
 * Aloud runs the same code on Gecko (Firefox desktop + Android) and Chromium (Chrome, Edge,
 * Brave, Opera). The two differ in ways that change *behaviour*, not just packaging — most
 * importantly whether a Worker can reach the GPU, which is the difference between Kokoro being
 * the best voice available and being unusably slow.
 *
 * Everything browser-specific is expressed here as a named capability so the rest of the
 * codebase can read as "if (caps.workerWebGPU)" instead of "if (Firefox)". Adding a browser
 * means adding a row here, not hunting for `// Firefox:` comments.
 *
 * Safe to import from any context — background, content script, options page, synth-host iframe
 * and the synthesis Worker. It never touches `browser.*` unconditionally, because Web Workers
 * have no extension APIs.
 */

/** Rendering/extension engine, which is what actually determines the capabilities below. */
export type BrowserEngine = 'gecko' | 'chromium' | 'unknown';

/** Rough form factor. Only Android matters today: it is the one mobile target that runs extensions. */
export type FormFactor = 'desktop' | 'android';

export interface BrowserCapabilities {
  engine: BrowserEngine;
  formFactor: FormFactor;

  /**
   * Is `navigator.gpu` expected inside a dedicated Worker?
   *
   * Chromium exposes WebGPU to workers. Firefox ships it disabled: with `dom.webgpu.enabled`
   * *and* `dom.webgpu.workers.enabled` switched on in `about:config` an extension worker really
   * does get an adapter (measured — Kokoro then loads `webgpu/fp32` and outruns Piper), but
   * neither pref is on by default, so the expectation for Gecko stays `false`.
   *
   * This is an **expectation, not an answer**, and it can be wrong in both directions: Chromium
   * exposes `navigator.gpu` on every desktop, including machines where `requestAdapter()` then
   * returns `null` (no Vulkan driver on Linux, blocklisted GPU, remote desktop, `--disable-gpu`),
   * and a Firefox user can switch the prefs above on. Anything that decides *how to run* — pool
   * size, queue depth, UI copy — must combine it with a real probe: `capabilitiesWithGpu()` for
   * a document-side probe, which may only *subtract*, and `applyWorkerGpuProbe()` for one
   * measured inside a worker, which is the answer and may add. `engine/runtime-env.ts` probes
   * again in the worker before selecting an execution provider.
   */
  workerWebGPU: boolean;

  /**
   * Can a content script call `new Worker(runtime.getURL(...))` directly?
   *
   * Chromium allows it for a web-accessible resource; Firefox enforces same-origin with no
   * exception and fails with an opaque "worker crashed". We use the `synth-host` iframe on both
   * regardless — one code path is worth more than the saved frame — but the distinction is
   * recorded here because it is the reason that iframe exists at all.
   */
  contentScriptCanSpawnExtensionWorker: boolean;

  /**
   * Does `browser.menus.getTargetElement(id)` exist?
   *
   * Firefox-only. It is what makes "Read from here" start at the exact element that was
   * right-clicked; without it we fall back to the first sentence in the viewport.
   */
  menusTargetElement: boolean;

  /**
   * Is the background context a service worker (Chromium) rather than an event page (Gecko)?
   *
   * A service worker has no DOM and is evicted more eagerly, so background state must stay
   * reconstructible. Aloud's background is already a thin router, but this flags the constraint.
   */
  backgroundIsServiceWorker: boolean;

  /** Touch-first UI: bigger hit targets, no hover affordances, a layout that fits a phone. */
  touchFirst: boolean;
}

function readUserAgent(): string {
  try {
    return globalThis.navigator?.userAgent ?? '';
  } catch {
    return '';
  }
}

/** Our own extension origin, if an extension API is reachable from this context. */
function extensionOrigin(): string {
  const g = globalThis as {
    browser?: { runtime?: { getURL?: (p: string) => string } };
    chrome?: { runtime?: { getURL?: (p: string) => string } };
  };
  for (const api of [g.browser, g.chrome]) {
    try {
      const url = api?.runtime?.getURL?.('/');
      if (url) return url;
    } catch {
      /* not an extension context, or the API is unavailable here */
    }
  }
  return '';
}

function detectEngine(): BrowserEngine {
  // 1. Extension-origin documents and Workers (options page, synth-host iframe, tts-worker):
  //    the scheme names the engine exactly, with no sniffing.
  const protocol = (() => {
    try {
      return globalThis.location?.protocol ?? '';
    } catch {
      return '';
    }
  })();
  if (protocol === 'moz-extension:') return 'gecko';
  if (protocol === 'chrome-extension:') return 'chromium';

  // 2. Content scripts run at the *page's* origin, so ask the extension API for our own URL.
  const origin = extensionOrigin();
  if (origin.startsWith('moz-extension:')) return 'gecko';
  if (origin.startsWith('chrome-extension:')) return 'chromium';

  // 3. Last resort — unit tests and anything embedding us outside an extension.
  const ua = readUserAgent();
  if (/firefox\/|gecko\//i.test(ua)) return 'gecko';
  if (/chrome\/|chromium\/|edg\//i.test(ua)) return 'chromium';
  return 'unknown';
}

function detectFormFactor(): FormFactor {
  return /android/i.test(readUserAgent()) ? 'android' : 'desktop';
}

function computeCapabilities(): BrowserCapabilities {
  const engine = detectEngine();
  const formFactor = detectFormFactor();
  const chromium = engine === 'chromium';
  return {
    engine,
    formFactor,
    // Chromium ships WebGPU in dedicated workers; Gecko keeps it behind about:config prefs that
    // are off by default (a worker probe can correct this — see applyWorkerGpuProbe).
    // Android GPUs are also excluded: Firefox is the only Android extension host today.
    workerWebGPU: chromium && formFactor === 'desktop',
    contentScriptCanSpawnExtensionWorker: chromium,
    menusTargetElement: engine === 'gecko',
    backgroundIsServiceWorker: chromium,
    touchFirst: formFactor === 'android',
  };
}

let cached: BrowserCapabilities | null = null;

/** The current context's capabilities. Computed once — nothing here changes at run time. */
export function capabilities(): BrowserCapabilities {
  return (cached ??= computeCapabilities());
}

/**
 * The current capabilities, corrected by a **document-side** GPU probe (`shared/gpu-probe.ts`).
 *
 * A document probe may only take the GPU *away*. Firefox gates the two contexts with separate
 * prefs (`dom.webgpu.enabled` for documents, `dom.webgpu.workers.enabled` for workers), so a
 * page that has WebGPU is no evidence that synthesis does — and claiming a GPU the worker cannot
 * reach is what sizes the pool at one worker and makes everything slower. Passing `null` (probe
 * not finished yet) leaves the expectation untouched.
 */
export function capabilitiesWithGpu(
  probe: { available: boolean } | null,
  base: BrowserCapabilities = capabilities(),
): BrowserCapabilities {
  if (!probe) return base;
  return { ...base, workerWebGPU: base.workerWebGPU && probe.available };
}

/**
 * Fold a completed GPU probe into this context's cached capabilities.
 *
 * Call it once, early, in a context that can probe (the options page). Everything that reads
 * `capabilities()` afterwards — engine standings, blurbs, hints — then describes the machine in
 * front of the user rather than the browser they happen to be running.
 */
export function applyGpuProbe(probe: { available: boolean }): BrowserCapabilities {
  return (cached = capabilitiesWithGpu(probe, capabilities()));
}

/**
 * Fold in a GPU probe that was run **inside a synthesis worker**, which is authoritative.
 *
 * That worker is the context that actually runs inference, so its answer replaces the
 * expectation outright rather than only narrowing it — this is how a Firefox user who has turned
 * on `dom.webgpu.workers.enabled` stops being told their browser has no GPU access, and how a
 * Chromium machine whose adapter request fails stops being promised one.
 */
export function applyWorkerGpuProbe(webgpu: boolean): BrowserCapabilities {
  return (cached = { ...capabilities(), workerWebGPU: webgpu });
}

/** Override the detected capabilities. Tests only. */
export function __setCapabilitiesForTest(caps: BrowserCapabilities | null): void {
  cached = caps;
}
