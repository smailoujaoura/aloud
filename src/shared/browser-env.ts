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
   * Chromium exposes WebGPU to workers. Firefox does not expose it to extension workers yet
   * (the worker logs "navigator.gpu is not present in this worker"), so the neural engines are
   * stuck on single-threaded WASM there. This is only the *expectation* used for defaults and
   * UI copy — `engine/runtime-env.ts` still probes for real before selecting a provider.
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
    // Chromium ships WebGPU in dedicated workers; Gecko does not expose it to extension workers.
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

/** Override the detected capabilities. Tests only. */
export function __setCapabilitiesForTest(caps: BrowserCapabilities | null): void {
  cached = caps;
}
