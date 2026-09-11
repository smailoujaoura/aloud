/**
 * Does this machine *actually* give us a GPU?
 *
 * `browser-env.ts` answers "could this browser expose WebGPU to an extension worker" — a static
 * fact about the browser. That is an upper bound, not an answer: Chromium exposes `navigator.gpu`
 * everywhere, but `requestAdapter()` still returns `null` on a machine where the GPU process
 * refuses to serve WebGPU (Chrome logs "No available adapters."). That happens routinely on
 * Linux without a Vulkan driver, on blocklisted GPUs, over remote desktop, and with the GPU
 * disabled by policy or by `--disable-gpu`.
 *
 * Treating the upper bound as the answer is exactly how Chromium ended up *slower* than Firefox
 * for Kokoro: the pipeline picked GPU settings (one worker, a shallow lookahead) and then ran on
 * a single WASM thread anyway. Everything that trades on "is there a GPU" therefore asks here,
 * and the probe result — not the browser name — decides.
 *
 * The probe costs a few milliseconds and is cached for the life of the context. It is only
 * meaningful in a document or worker that can see `navigator.gpu`; call it from the options page
 * or the synth-host, not from a content script (which runs at the page's origin and would
 * measure the *page's* access, not ours).
 */

export type GpuAvailability =
  /** `requestAdapter()` returned an adapter — the GPU path is real. */
  | 'available'
  /** `navigator.gpu` exists but there is no adapter for us (driver, blocklist, policy, headless). */
  | 'no-adapter'
  /** No `navigator.gpu` at all (Firefox extension workers, older browsers, Android). */
  | 'unsupported';

export interface GpuProbe {
  status: GpuAvailability;
  available: boolean;
  /** Adapter vendor/architecture when the browser exposes it — for the options page and logs. */
  adapterInfo?: string;
  /** Whether the adapter advertises `shader-f16`, which Kokoro's fp16 path needs. */
  shaderF16?: boolean;
  /** One sentence a human can act on. */
  detail: string;
}

interface NavigatorGpuLike {
  requestAdapter(options?: { powerPreference?: string }): Promise<AdapterLike | null>;
}

interface AdapterLike {
  features?: Iterable<string>;
  info?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<Record<string, unknown>>;
}

function gpuOf(scope: unknown): NavigatorGpuLike | undefined {
  return (scope as { navigator?: { gpu?: NavigatorGpuLike } } | undefined)?.navigator?.gpu;
}

let cached: GpuProbe | null = null;
let inFlight: Promise<GpuProbe> | null = null;

const UNSUPPORTED: GpuProbe = {
  status: 'unsupported',
  available: false,
  detail: 'This browser does not expose WebGPU here, so synthesis runs on the CPU.',
};

/**
 * Probe once and remember the answer.
 *
 * Never throws: a browser that implements `navigator.gpu` badly (or a policy that makes
 * `requestAdapter` reject) must degrade to "no GPU", not break synthesis.
 */
export function probeGpu(scope: unknown = globalThis): Promise<GpuProbe> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  const gpu = gpuOf(scope);
  if (!gpu) {
    cached = UNSUPPORTED;
    return Promise.resolve(cached);
  }

  inFlight = (async (): Promise<GpuProbe> => {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        return {
          status: 'no-adapter',
          available: false,
          detail:
            'WebGPU is present but no GPU adapter was granted, so synthesis runs on the CPU. ' +
            'On Linux this usually means the browser has no Vulkan-capable GPU driver.',
        };
      }
      let adapterInfo: string | undefined;
      let shaderF16 = false;
      try {
        const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
        const parts = info
          ? Object.entries(info)
              .filter(([, v]) => typeof v === 'string' && v)
              .map(([k, v]) => `${k}=${String(v)}`)
          : [];
        adapterInfo = parts.length ? parts.join(' ') : undefined;
        shaderF16 = adapter.features ? [...adapter.features].includes('shader-f16') : false;
      } catch {
        /* adapter metadata is best-effort */
      }
      return {
        status: 'available',
        available: true,
        adapterInfo,
        shaderF16,
        detail: `GPU acceleration is active${adapterInfo ? ` (${adapterInfo})` : ''}.`,
      };
    } catch (err) {
      return {
        status: 'no-adapter',
        available: false,
        detail: `Asking for a GPU adapter failed (${err instanceof Error ? err.message : String(err)}), so synthesis runs on the CPU.`,
      };
    }
  })()
    .then((result) => {
      cached = result;
      inFlight = null;
      return result;
    })
    .catch(() => {
      cached = UNSUPPORTED;
      inFlight = null;
      return cached;
    });

  return inFlight;
}

/** The cached probe, if one has completed in this context. Never triggers a probe. */
export function gpuProbeIfKnown(): GpuProbe | null {
  return cached;
}

/** Tests only. */
export function __setGpuProbeForTest(probe: GpuProbe | null): void {
  cached = probe;
  inFlight = null;
}
