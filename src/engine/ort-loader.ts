/**
 * Loads ONNX Runtime Web once, at run time, from the vendored copy in `vendor/ort/`.
 *
 * onnxruntime-web is *externalised* from the worker bundle (bundling it makes Vite inline every
 * `.wasm` as base64 — a 100 MB+ bundle). Loading `ort.bundle.min.mjs` by URL instead lets ORT
 * resolve its own `.mjs`/`.wasm` siblings from the same directory.
 *
 * Kokoro's transformers.js imports the very same file (the worker build points its
 * `onnxruntime-web` import here), so it gets this instance, already pointed at the WebAssembly
 * inside the extension — and then leaves the path alone instead of setting its default, a CDN.
 * Not through `globalThis[Symbol.for('onnxruntime')]`: transformers.js does use a runtime
 * registered there, but offers it no device at all ("Unsupported device: wasm").
 */
import { assetUrl } from './runtime-env';

type OrtModule = typeof import('onnxruntime-web');

let ortPromise: Promise<OrtModule> | null = null;

export function loadOrt(): Promise<OrtModule> {
  if (ortPromise) return ortPromise;
  const url = assetUrl('vendor/ort/ort.bundle.min.mjs');
  ortPromise = (async () => {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Could not load ONNX Runtime Web from ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Prefer the module namespace (has the named InferenceSession / Tensor / env exports);
    // fall back to the default export if a build only exposes that.
    const ort = ('InferenceSession' in mod ? mod : (mod.default as unknown)) as OrtModule | undefined;
    if (!ort || !ort.env || !ort.env.wasm) {
      throw new Error(
        `ONNX Runtime Web loaded from ${url} but is missing expected exports (InferenceSession / env.wasm)`,
      );
    }

    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    // SIMD is the single biggest lever for the neural engines on the single-threaded WASM path
    // (Kokoro is ~2-3x slower without it). It is on by default, but pin it so a future ORT
    // default change can't silently regress synthesis speed.
    ort.env.wasm.simd = true;
    ort.env.wasm.wasmPaths = assetUrl('vendor/ort/');
    return ort;
  })().catch((err) => {
    ortPromise = null; // let a later init retry from scratch
    throw err;
  });
  return ortPromise;
}
