/**
 * What each synthesis engine is, and how good an idea it is *on this browser*.
 *
 * The three engines are not equally viable everywhere, and the gap is large enough that
 * presenting them identically would be misleading. The deciding factor is whether a Worker can
 * reach the GPU:
 *
 *  - **Chromium desktop** exposes WebGPU to workers. Kokoro runs on the GPU and is both the best
 *    sounding and comfortably fast, so it is the one to recommend.
 *  - **Firefox** does not expose WebGPU to extension workers (Bug 1673477 also rules out
 *    `SharedArrayBuffer`, so ONNX Runtime is stuck on one WASM thread). Kokoro lands around 3×
 *    slower than real time there and only keeps up by running a pool of workers. It stays
 *    available, clearly marked, but Piper is the sane default.
 *  - **Android** has neither the GPU access nor the cores nor the memory. Piper only.
 *
 * Keeping this in one place means the options page, the control bar and the docs cannot drift
 * apart, and adding a browser is a change here rather than a hunt for hardcoded "slow on
 * Firefox" strings.
 */
import { capabilities, type BrowserCapabilities } from '@/shared/browser-env';
import type { EngineId } from '@/shared/settings';

/** How strongly to steer the user toward an engine on the current browser. */
export type EngineStanding =
  /** The best choice here. */
  | 'recommended'
  /** Works well; a reasonable pick. */
  | 'good'
  /** Usable but slow — shown with a warning, never preselected. */
  | 'slow'
  /** Not realistically usable on this device. */
  | 'unsuitable';

export interface EngineInfo {
  id: EngineId;
  name: string;
  /** Short chip shown next to the name. */
  tag: string;
  /** One or two sentences under the engine picker and in its panel. */
  blurb: string;
  /** Human-readable download footprint. */
  approxSize: string;
  /**
   * Substring of a cache key meaning "the shared model is present". Kokoro and Supertonic each
   * download one model that unlocks all their voices; Piper downloads per voice and has none.
   */
  cacheHint?: string;
  standing: EngineStanding;
}

const NAMES: Record<EngineId, { name: string; approxSize: string; cacheHint?: string }> = {
  piper: { name: 'Piper', approxSize: '20–60 MB per voice' },
  kokoro: { name: 'Kokoro-82M', approxSize: '~86 MB (q8)', cacheHint: 'Kokoro-82M' },
  supertonic: { name: 'Supertonic-2', approxSize: '~262 MB', cacheHint: 'supertonic-2' },
};

/** The reason the neural engines are slow without a GPU, phrased for whoever is reading it. */
function noGpuReason(caps: BrowserCapabilities): string {
  if (caps.formFactor === 'android') return 'phone CPUs are far too slow for it';
  if (caps.engine === 'gecko') {
    return 'Firefox gives extensions no GPU access and a single WASM thread';
  }
  return 'no usable GPU was found, so it runs on a single WASM thread';
}

function describe(id: EngineId, caps: BrowserCapabilities): { tag: string; blurb: string; standing: EngineStanding } {
  const gpu = caps.workerWebGPU;
  const mobile = caps.formFactor === 'android';

  switch (id) {
    case 'piper':
      return {
        tag: mobile ? 'The only sensible choice here' : 'Fast · runs anywhere',
        blurb:
          'A small, fast neural voice. Comfortably faster than real time on any machine, including phones. ' +
          'Each voice is a separate 20–60 MB download.',
        standing: gpu && !mobile ? 'good' : 'recommended',
      };

    case 'kokoro':
      if (mobile) {
        return {
          tag: 'Too slow on phones',
          blurb:
            'The most natural voice here, but it needs a desktop GPU to keep up — ' +
            `${noGpuReason(caps)}. Use Piper on Android.`,
          standing: 'unsuitable',
        };
      }
      if (gpu) {
        return {
          tag: 'Best quality · GPU accelerated',
          blurb:
            'The most natural, expressive voice here, running on your GPU via WebGPU — comfortably ' +
            'faster than real time. One 86 MB download unlocks all 54 voices.',
          standing: 'recommended',
        };
      }
      return {
        tag: 'Best quality · slow here',
        blurb:
          'The most natural, expressive voice here, but around 3× slower than real time because ' +
          `${noGpuReason(caps)}. It leans on parallel workers and still needs a moment to get ahead. ` +
          'One 86 MB download unlocks all 54 voices.',
        standing: 'slow',
      };

    case 'supertonic':
      if (mobile) {
        return {
          tag: 'Too large for phones',
          blurb: `A 262 MB download and ${noGpuReason(caps)}. Use Piper on Android.`,
          standing: 'unsuitable',
        };
      }
      return {
        tag: gpu ? 'Expressive · GPU accelerated' : 'Expressive · medium speed',
        blurb: gpu
          ? 'Expressive and GPU accelerated. One ~262 MB download unlocks all 10 voices.'
          : 'Roughly real time on the CPU and quite expressive. One ~262 MB download unlocks all 10 voices.',
        standing: 'good',
      };
  }
}

export function engineInfo(id: EngineId, caps: BrowserCapabilities = capabilities()): EngineInfo {
  return { id, ...NAMES[id], ...describe(id, caps) };
}

export const ENGINE_IDS: readonly EngineId[] = ['piper', 'kokoro', 'supertonic'];

/** All engines, best-supported first, for building a picker. */
export function rankedEngines(caps: BrowserCapabilities = capabilities()): EngineInfo[] {
  const order: Record<EngineStanding, number> = { recommended: 0, good: 1, slow: 2, unsuitable: 3 };
  return ENGINE_IDS.map((id) => engineInfo(id, caps)).sort(
    (a, b) => order[a.standing] - order[b.standing],
  );
}
