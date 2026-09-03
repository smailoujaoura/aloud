// Copies the ONNX Runtime Web runtime files that must be served from the extension package into
// public/vendor/ort/. The worker loads ort.bundle.min.mjs at run time (onnxruntime-web is
// externalised from the worker bundle) and ORT then loads its own .mjs/.wasm siblings from the
// same directory via ort.env.wasm.wasmPaths.
//
// The transformers/Kokoro path uses the SAME ORT instance (globalThis[Symbol.for('onnxruntime')]).
// eSpeak-NG is not here: the `phonemizer` package inlines its WASM + data as base64.
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ORT_FILES = [
  'ort.bundle.min.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

export function syncAssets() {
  const src = join(root, 'node_modules/onnxruntime-web/dist');
  const dest = join(root, 'public/vendor/ort');
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of ORT_FILES) {
    const s = join(src, f);
    const d = join(dest, f);
    if (!existsSync(s)) throw new Error(`missing ${s} — reinstall onnxruntime-web`);
    if (existsSync(d) && statSync(d).size === statSync(s).size) continue;
    copyFileSync(s, d);
    copied++;
  }
  console.log(`[sync-assets] ${copied} ORT file(s) refreshed into public/vendor/ort/`);
}

if (import.meta.url === 'file://' + process.argv[1]) syncAssets();
