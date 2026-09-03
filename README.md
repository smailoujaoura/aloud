# Aloud — Offline Neural Reader (Firefox)

Read any article aloud with a **fully local** neural voice. No servers, no accounts, nothing
leaves your device after the one-time voice download.

- **Extraction** — [Mozilla Readability](https://github.com/mozilla/readability) strips nav / ads
  and grabs the article text.
- **Voices** — [Piper](https://github.com/rhasspy/piper) (fast, ~20–60 MB) by default; optional
  [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) for higher quality. Inference runs on
  [ONNX Runtime Web](https://onnxruntime.ai/) (WebAssembly, WebGPU when available).
- **Gapless playback** — sentences are synthesised a few ahead of the playhead and scheduled
  sample-accurately through the Web Audio API, so there is no pause between them.
- **In-place highlighting** — the sentence being spoken is highlighted with the CSS Custom
  Highlight API (zero DOM mutation, cannot break page layout; falls back to a `<span>` on
  Firefox < 140).
- **Offline & private** — models download once from Hugging Face and are cached in IndexedDB.

## Install (temporary, for testing)

1. `pnpm install && pnpm build`
2. Firefox → `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
   `.output/firefox-mv3/manifest.json`
3. Open an article, click the **Aloud** toolbar button (or press `Alt+Shift+R`).
   The first run downloads the voice; after that it works offline.

Right-click gives **Read selection aloud** and **Read from here**. Settings (engine, voice, speed,
highlight colour, cached-model management) are on the add-on's options page.

## How it works

Firefox MV3 has no offscreen-documents API, but its background is a real DOM event page — and the
hard constraint is that `SharedArrayBuffer` is unavailable to extensions, so ONNX Runtime runs
single-threaded. The engine therefore lives in a **Web Worker spawned from a `moz-extension://`
URL by the content script**: that gives it the extension's CSP (`wasm-unsafe-eval`) regardless of
the host page, and a lifetime tied to the tab rather than the ~30 s event-page timeout. The
content script keeps the DOM work (extraction, highlighting, audio scheduling); the background
page is a thin coordinator that injects on `activeTab` and enforces one active session at a time.

Full rationale: [`docs/DESIGN.md`](docs/DESIGN.md). Build details: [`BUILD.md`](BUILD.md).

## Licence

**GPL-3.0-or-later** — because eSpeak-NG (the phonemizer) is GPLv3. See
[`THIRD_PARTY.md`](THIRD_PARTY.md) for every bundled component and every voice's dataset licence.
