// Copies the third-party runtime files that must be served from the extension package itself.
//
//  - public/vendor/ort/    ONNX Runtime Web. The worker loads ort.bundle.min.mjs at run time
//    (onnxruntime-web is externalised from the worker bundle) and ORT then loads its own
//    .mjs/.wasm siblings from the same directory via ort.env.wasm.wasmPaths. The
//    transformers/Kokoro path uses the SAME ORT instance (globalThis[Symbol.for('onnxruntime')]).
//  - public/vendor/pdfjs/  pdf.js, for reading PDFs (src/pdf/). Same reasoning as ORT: the
//    library is imported by URL at run time so its 1.3 MB worker is never inlined into a page
//    bundle, and pdf.js can resolve its own worker from the extension origin under our CSP.
//
//  - public/vendor/piper/  piper_phonemize (eSpeak-NG with every language's data) for Piper voices.
//    Loaded by URL from the synthesis worker; see src/engine/g2p/piper-phonemize.ts. (Kokoro still
//    uses the English-only `phonemizer` package that kokoro-js bundles, which is all it needs.)
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs';
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

const PDFJS_FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

const PIPER_PHONEMIZE_FILES = ['piper_phonemize.wasm', 'piper_phonemize.data'];

/**
 * Whole directories pdf.js loads by URL at run time when it *renders* a page.
 *
 * `standard_fonts/` supplies the Base-14 fonts (Helvetica, Times, Courier …) that PDFs are
 * allowed to reference without embedding; without it pdf.js warns "Ensure that the
 * standardFontDataUrl API parameter is provided" and draws those pages with substituted glyphs.
 * `cmaps/` does the same job for the predefined CJK encodings. Both are only fetched for
 * documents that actually need them.
 */
const PDFJS_DIRS = ['standard_fonts', 'cmaps'];

export function syncAssets() {
  const piperSrc = join(root, 'node_modules/@diffusionstudio/piper-wasm/build');
  const piperDest = join(root, 'public/vendor/piper');
  mkdirSync(piperDest, { recursive: true });
  let piperCopied = 0;
  for (const f of PIPER_PHONEMIZE_FILES) {
    const s = join(piperSrc, f);
    const d = join(piperDest, f);
    if (!existsSync(s)) throw new Error(`missing ${s} — reinstall @diffusionstudio/piper-wasm`);
    if (existsSync(d) && statSync(d).size === statSync(s).size) continue;
    copyFileSync(s, d);
    piperCopied++;
  }
  console.log(`[sync-assets] ${piperCopied} piper_phonemize file(s) refreshed into public/vendor/piper/`);

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

  // The *legacy* build, deliberately: the modern one assumes very recent engines (it calls
  // `Map.prototype.getOrInsertComputed`, which Chrome 143 still does not have) and fails at run
  // time with "getOrInsertComputed is not a function". Legacy matches the browsers this
  // extension supports (Chrome 120+, Firefox 142+) and is within a few KB of the same size.
  const pdfSrc = join(root, 'node_modules/pdfjs-dist/legacy/build');
  const pdfDest = join(root, 'public/vendor/pdfjs');
  mkdirSync(pdfDest, { recursive: true });
  let pdfCopied = 0;
  for (const f of PDFJS_FILES) {
    const s = join(pdfSrc, f);
    const d = join(pdfDest, f);
    if (!existsSync(s)) throw new Error(`missing ${s} — reinstall pdfjs-dist`);
    if (existsSync(d) && statSync(d).size === statSync(s).size) continue;
    copyFileSync(s, d);
    pdfCopied++;
  }
  for (const dir of PDFJS_DIRS) {
    const s = join(root, 'node_modules/pdfjs-dist', dir);
    const d = join(pdfDest, dir);
    if (!existsSync(s)) throw new Error(`missing ${s} — reinstall pdfjs-dist`);
    mkdirSync(d, { recursive: true });
    for (const f of readdirSync(s)) {
      const sf = join(s, f);
      const df = join(d, f);
      if (existsSync(df) && statSync(df).size === statSync(sf).size) continue;
      copyFileSync(sf, df);
      pdfCopied++;
    }
  }
  console.log(`[sync-assets] ${pdfCopied} pdf.js file(s) refreshed into public/vendor/pdfjs/`);
}

if (import.meta.url === 'file://' + process.argv[1]) syncAssets();
