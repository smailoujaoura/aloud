# Building Aloud

## Requirements

- Node.js ≥ 20 (developed on 22)
- pnpm ≥ 9 (`npm i -g pnpm`) — npm also works with `--legacy-peer-deps` (already set in `.npmrc`)
- Firefox ≥ 142 or Chromium ≥ 120 to run it

## Commands

```bash
pnpm install            # also runs `wxt prepare`
pnpm build              # both targets: .output/firefox-mv3/ and .output/chrome-mv3/
pnpm build:firefox      # -> .output/firefox-mv3/
pnpm build:chrome       # -> .output/chrome-mv3/
pnpm zip                # -> .output/*.zip   (packaged for AMO / the Chrome Web Store)
pnpm dev                # live-reload dev build + launches Firefox
pnpm dev:chrome         # live-reload dev build + launches Chrome
pnpm compile            # tsc --noEmit
pnpm test               # vitest (pure logic + happy-dom DOM tests)
pnpm lint:ext           # web-ext lint on the Firefox output
pnpm test:e2e:firefox   # the Firefox build in a real headless Firefox (see below)
```

### The Firefox end-to-end check

`scripts/e2e-firefox.mjs` installs `.output/firefox-mv3` into Playwright's Firefox as a temporary
add-on, reads an article aloud and checks each stage: the voice loads and returns audio, playback
starts, the word highlight moves through every word in order, and "Save as MP3" downloads a real
MP3. On failure it exits non-zero and leaves a screenshot in `.output/e2e-firefox/`.

It needs `npx playwright install firefox`, and an audio output: Firefox never starts an
AudioContext without one. On a headless Linux machine, run a PulseAudio null sink
(`load-module module-null-sink`) and point `PULSE_SERVER` at it. `E2E_LD_LIBRARY_PATH` adds
library folders for Firefox (GTK 3, libpulse) when they are not installed system-wide.

## The two outputs are not interchangeable

This is the single most common way to waste an hour on this project, so it is worth stating
plainly. WXT generates a different background declaration per browser:

| | Firefox | Chromium |
|---|---|---|
| Background | `"background": { "scripts": ["background.js"], "type": "module" }` (event page) | `"background": { "service_worker": "background.js", "type": "module" }` |
| `browser_specific_settings` | present (`gecko`, `gecko_android`) | omitted — Chromium warns on unknown keys |
| Vite target | `firefox128` | `chrome120` |

Loading `.output/firefox-mv3` in Chrome produces:

```
'background.scripts' requires manifest version of 2 or lower.
```

…and then the extension *appears* to install — icon, name, options page all present — but the
toolbar button does nothing, because the background never loaded and therefore never registered
`action.onClicked`. Load `.output/chrome-mv3` instead.

The synthesis worker bundle is deliberately **not** per-browser: `scripts/build-worker.mjs`
targets `['firefox128', 'chrome120']` and lets esbuild take the lower bound, so the shared
`public/` output cannot be clobbered by whichever browser was built last. Runtime differences in
the worker are capability checks (`src/shared/browser-env.ts`), not build flags.

## What `pnpm build` does

1. `wxt.config.ts`'s `build:before` hook runs `scripts/prebuild.mjs`, which:
   - `scripts/gen-voices.mjs` — regenerates `public/models.json` from `scripts/models.base.json`.
   - `scripts/sync-assets.mjs` — copies ONNX Runtime Web's `ort.bundle.min.mjs` +
     `ort-wasm-simd-threaded[.jsep].{mjs,wasm}` from `node_modules` into `public/vendor/ort/`,
     and pdf.js's `pdf.min.mjs` + `pdf.worker.min.mjs`, plus its `standard_fonts/` (the Base-14
     fonts a PDF may reference without embedding) and `cmaps/` (predefined CJK encodings), into
     `public/vendor/pdfjs/` — about 4 MB, needed only once pages are *drawn* rather than just
     read. The **legacy**
     pdf.js build is the one copied: the modern build uses `Map.prototype.getOrInsertComputed`,
     which Chrome 143 and our Firefox baseline do not have, and the PDF reader page dies with
     `getOrInsertComputed is not a function` on the first document.
   - `scripts/build-worker.mjs` — a standalone Vite build of `src/worker/entry.ts` →
     `.gen/worker/tts-worker.js` (ES-module worker), plus `src/synth-host/entry.ts` →
     `.gen/worker/synth-host.js` (a classic IIFE). `onnxruntime-web` / `onnxruntime-common` are
     **external**, rewritten via `output.paths` to `./vendor/ort/ort.bundle.min.mjs`, so ORT's
     ~33 MB of WASM is never base64-inlined. The output is copied into `public/`.
2. WXT builds `background`, `options`, `pdf`, `welcome` (the first-run walkthrough) and the
   `reader-inject` unlisted script, then assembles
   the output directory with a generated `manifest.json`.

## Loading it

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`.output/firefox-mv3/manifest.json`.

**Firefox for Android** — requires a signed build; use `pnpm zip:firefox` and an AMO-signed
`.xpi`, or Firefox Nightly with a custom add-on collection. The manifest declares
`gecko_android`, without which AMO treats the add-on as desktop-only.

**Chromium** — `chrome://extensions` → **Developer mode** → **Load unpacked** → select the
`.output/chrome-mv3` **folder** (not a file).

Then click the toolbar button (or press `Alt+Shift+R`) on any article. First activation downloads
the selected voice once; after that it is fully offline.

## Regenerating model integrity hashes (optional)

`public/models.json` supports an optional `sha256` per Piper file. To populate it:

```bash
curl -sL <onnx-url>        | sha256sum
curl -sL <onnx.json-url>   | sha256sum
```

and add `"sha256": { "onnx": "...", "config": "..." }` to the voice entry. When present the hash
is verified after download (`src/engine/model-cache.ts`).

## Known `web-ext lint` warnings (all non-blocking)

| Warning | Count | Why it is expected |
|---|---|---|
| `DANGEROUS_EVAL` in `vendor/ort/ort.bundle.min.mjs` and `vendor/ort/ort-wasm-simd-threaded.jsep.mjs` | 2 | ONNX Runtime's WASM bootstrap. Covered by our CSP `'wasm-unsafe-eval'`. |
| `DANGEROUS_EVAL` in `vendor/pdfjs/pdf.min.mjs` and `vendor/pdfjs/pdf.worker.min.mjs` | 2 | pdf.js's optional expression evaluator for PDF function objects. We load it with `isEvalSupported: false` (`src/pdf/load-pdf.ts`), so the branch is never taken. |
| `UNSAFE_VAR_ASSIGNMENT` "call to import" in `vendor/rt/ort-loader-*.js`, `vendor/ort/ort.bundle.min.mjs`, `chunks/pdf-*.js` and `vendor/pdfjs/pdf*.min.mjs` | 4 | Deliberate runtime `import()` of a vendored module by URL — both loaders resolve it with `browser.runtime.getURL`, so the argument is never page-controlled. |
| `UNSAFE_VAR_ASSIGNMENT` "assignment to innerHTML" in `reader-inject.js` and `chunks/session-*.js` | 4 | Inside the bundled `@mozilla/readability`, which parses a *clone* of the document and is bundled into the content script and into the shared reader-session chunk the PDF page and the walkthrough both load. None of our own code assigns `innerHTML`; the control bar, options page, PDF reader and walkthrough build every node with `createElement` (see `src/shared/dom.ts`). |
| `UNSAFE_VAR_ASSIGNMENT` in `vendor/pdfjs/pdf.worker.min.mjs` | 1 | pdf.js's own worker bootstrap. |

There are **no errors** — 13 warnings, 0 notices, all from vendored code. Verify with:

```bash
npx web-ext lint --source-dir .output/firefox-mv3 -o json | jq '{errors: (.errors|length), warnings: (.warnings|length)}'
```

## Architecture summary

```
toolbar click ──► background   (event page on Firefox, service worker on Chromium)
                    │ scripting.executeScript (activeTab, no host perms)
                    ▼
              reader-inject.js  (content script, page DOM, NO wasm)
                    │  content/playlist        Readability → blocks → sentences + Ranges
                    │  audio/scheduler         gapless AudioBufferSourceNode scheduling
                    │  highlight/highlighter   CSS Custom Highlight API (span fallback)
                    │  ui/control-bar          shadow-DOM playback bar
                    │  engine/worker-client    hidden synth-host.html iframe + MessagePort
                    ▼
              synth-host.html   (extension origin; owns a pool of workers)
                    │  pool size from src/synth-host/entry.ts: 1 on the GPU path,
                    │  several on the CPU path to keep ahead of playback
                    ▼
              tts-worker.js     (extension origin ⇒ extension CSP ⇒ wasm-unsafe-eval)
                    │  ORT: WebGPU where available, else single-thread WASM + SIMD
                    │  Piper: eSpeak-NG G2P + hand-rolled VITS session
                    │  Kokoro: kokoro-js + transformers, our IndexedDB cache
                    │  Supertonic: four ORT graphs + flow matching
                    ▼  transferable Float32 PCM
```

See `docs/DESIGN.md` for the full rationale (event pages vs. service workers vs. offscreen
documents, the SharedArrayBuffer ceiling, CSP, CORS).

`speed-inject.js` is the second content script: the video/audio speed control
(`src/media-speed/`). Like the reader it is never declared in the manifest — the `media-speed`
command injects it with `activeTab`, and `background.ts` registers it (via
`scripting.registerContentScripts`) only for the sites in `mediaSpeed.alwaysOn`, each of which
the settings page has had granted from a click.
