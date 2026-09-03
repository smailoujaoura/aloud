# Building Aloud

## Requirements

- Node.js ≥ 20 (developed on 22)
- pnpm ≥ 9 (`npm i -g pnpm`) — npm also works with `--legacy-peer-deps` (already set in `.npmrc`)
- Firefox ≥ 140 to run it

## Commands

```bash
pnpm install            # also runs `wxt prepare`
pnpm build              # -> .output/firefox-mv3/   (production)
pnpm zip                # -> .output/*.zip          (packaged for AMO / about:debugging)
pnpm dev                # live-reload dev build + launches Firefox (needs a local Firefox)
pnpm compile            # tsc --noEmit
pnpm test               # vitest (pure logic + happy-dom DOM tests)
pnpm lint:ext           # web-ext lint on the built output
```

## What `pnpm build` does

1. `wxt.config.ts`'s `build:before` hook runs `scripts/prebuild.mjs`, which:
   - `scripts/sync-assets.mjs` — copies ONNX Runtime Web's `ort.bundle.min.mjs` +
     `ort-wasm-simd-threaded[.jsep].{mjs,wasm}` from `node_modules` into `public/vendor/ort/`.
   - `scripts/build-worker.mjs` — a standalone Vite build of `src/worker/entry.ts` →
     `.gen/worker/tts-worker.js` (ES-module worker). `onnxruntime-web` / `onnxruntime-common` are
     **external**, rewritten via `output.paths` to `./vendor/ort/ort.bundle.min.mjs`, so ORT's
     WASM is never inlined. The output is copied into `public/`.
2. WXT builds `background`, `options`, and the `reader-inject` unlisted script, then assembles
   `.output/firefox-mv3/` with a generated `manifest.json`.

## Loading it in Firefox

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`.output/firefox-mv3/manifest.json`. Then click the toolbar button (or press `Alt+Shift+R`) on any
article. First activation downloads the selected voice (~20–60 MB Piper / ~86 MB Kokoro-q8) once;
after that it is fully offline.

## Regenerating model integrity hashes (optional)

`public/models.json` supports an optional `sha256` per Piper file. To populate it:

```bash
curl -sL <onnx-url>        | sha256sum
curl -sL <onnx.json-url>   | sha256sum
```

and add `"sha256": { "onnx": "...", "config": "..." }` to the voice entry. When present the hash
is verified after download (`src/engine/model-cache.ts`).

## Known `web-ext lint` warnings (all non-blocking)

| Warning | Why it is expected |
|---|---|
| `DANGEROUS_EVAL` in `vendor/ort/*.mjs` | ONNX Runtime's WASM bootstrap. Covered by our CSP `'wasm-unsafe-eval'`. |
| `UNSAFE_VAR_ASSIGNMENT` "call to import" in `tts-worker.js` / `ort.bundle.min.mjs` | Deliberate runtime `import()` of the vendored ORT module by URL. |
| `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` | `data_collection_permissions` needs Firefox-for-Android 142; Aloud targets desktop. |

There are **no errors**.

## Architecture summary

```
toolbar click ──► background (event page)
                    │ scripting.executeScript (activeTab, no host perms)
                    ▼
              reader-inject.js  (content script, page DOM, NO wasm)
                    │  Readability → segmentation → fuzzy DOM alignment
                    │  AudioContext + gapless AudioBufferSourceNode scheduler
                    │  CSS Custom Highlight API (span fallback < FF140)
                    │  new Worker(moz-extension://…/tts-worker.js, {type:'module'})
                    ▼
              tts-worker.js  (extension origin ⇒ extension CSP ⇒ wasm-unsafe-eval)
                    │  ORT single-thread WASM (+ WebGPU when available)
                    │  Piper: eSpeak-NG G2P + hand-rolled VITS session
                    │  Kokoro: kokoro-js + transformers, our IndexedDB cache
                    ▼  transferable Float32 PCM
```

See the design document in `docs/DESIGN.md` for the full rationale (Firefox MV3 event pages vs.
offscreen documents, the SharedArrayBuffer ceiling, CSP, CORS).
