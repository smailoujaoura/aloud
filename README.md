# Aloud — Offline Neural Reader

Read any article aloud with a **fully local** neural voice. No servers, no accounts, nothing
leaves your device after the one-time voice download.

Runs on **Firefox** (desktop and Android) and **Chromium** (Chrome, Edge, Brave, Opera).

- **Extraction** — [Mozilla Readability](https://github.com/mozilla/readability) strips nav / ads
  and grabs the article text.
- **Voices** — [Piper](https://github.com/rhasspy/piper) (fast, ~20–60 MB per voice),
  [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (best quality, ~86 MB) and
  Supertonic-2 (~262 MB). Inference runs on [ONNX Runtime Web](https://onnxruntime.ai/):
  WebGPU where the browser allows it, WebAssembly everywhere else.
- **Gapless playback** — sentences are synthesised a few ahead of the playhead and scheduled
  sample-accurately through the Web Audio API, so there is no pause between them.
- **In-place highlighting** — the sentence being spoken is highlighted with the CSS Custom
  Highlight API (zero DOM mutation, cannot break page layout), with a `<span>` fallback.
- **Offline & private** — models download once from Hugging Face and are cached on the device.

## Which voice to use

This is the one thing that differs meaningfully by browser, because it comes down to whether the
extension's Worker can reach the GPU:

| | Piper | Kokoro-82M | Supertonic-2 |
|---|---|---|---|
| **Chromium desktop** | fast | **best — runs on WebGPU** | good |
| **Firefox desktop** | **best choice — fast** | works, ~3× slower than real time | roughly real time |
| **Firefox Android** | **the only sensible choice** | too slow | too large |

Firefox does not expose WebGPU to extension workers yet, and extensions get no
`SharedArrayBuffer` ([bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)), so
ONNX Runtime is stuck on a single WASM thread there. Aloud compensates with a pool of synthesis
workers, but Piper remains the comfortable default. On Chromium the GPU path makes Kokoro both
the best sounding option and a fast one. The options page tells you which applies to your
browser; you never have to remember this table.

## Install (temporary, for testing)

```bash
npm install
npm run build          # builds BOTH .output/firefox-mv3 and .output/chrome-mv3
```

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
`.output/firefox-mv3/manifest.json`

**Chrome / Edge / Brave** — `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select the `.output/chrome-mv3` **folder**

> Load the folder that matches the browser. The two manifests are not interchangeable: Firefox
> MV3 uses a background *event page* (`background.scripts`) and Chromium uses a *service worker*
> (`background.service_worker`). Loading the Firefox build in Chrome fails with
> `'background.scripts' requires manifest version of 2 or lower`, and because the background then
> never runs, the toolbar icon appears but does nothing.

Open an article and click the **Aloud** toolbar button (or press `Alt+Shift+R`). The first run
downloads the voice; after that it works offline. Right-click gives **Read selection aloud** and
**Read from here**. Settings — engine, voice, speed, highlight colour, cached-model management —
are on the extension's options page.

## How it works

The synthesis engine runs in a **Web Worker at the extension origin**, not in the content script.
That is the load-bearing decision: the Worker gets the extension's CSP (`wasm-unsafe-eval`)
regardless of what the host page's CSP allows, and a lifetime tied to the tab rather than the
~30 s idle eviction that both browsers apply to background contexts.

The Worker is created by a hidden `synth-host.html` iframe rather than directly by the content
script, because Firefox forbids a content script from constructing a `moz-extension://` Worker.
Chromium would allow it, but routing both through the iframe keeps one code path.

The content script keeps all the DOM work — extraction, sentence planning, highlighting, audio
scheduling — and the background is a thin coordinator that injects on `activeTab` and enforces
one active session at a time.

Everything that genuinely differs between browsers is a named capability in
[`src/shared/browser-env.ts`](src/shared/browser-env.ts), so the rest of the code reads
`if (caps.workerWebGPU)` rather than `if (Firefox)`.

Full rationale: [`docs/DESIGN.md`](docs/DESIGN.md). Build details: [`BUILD.md`](BUILD.md).

## Licence

**GPL-3.0-or-later** — because eSpeak-NG (the phonemizer) is GPLv3. See
[`THIRD_PARTY.md`](THIRD_PARTY.md) for every bundled component and every voice's dataset licence.
