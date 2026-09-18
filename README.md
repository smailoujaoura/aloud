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
  sample-accurately through the Web Audio API, so there is no pause between them. Where the GPU
  is out of reach a pool of workers synthesises several sentences at once, which is what keeps
  the slower voices ahead of the playhead.
- **PDFs, still looking like PDFs** — a PDF in a tab has no text an extension can reach, so
  Aloud opens it in a reader of its own, draws the real pages with
  [pdf.js](https://mozilla.github.io/pdf.js/) and highlights each sentence **on the page itself**
  — figures, tables and columns intact. A reflowed-text view is one setting away for small
  screens. A PDF on a website needs one click to grant Aloud access to that site; local
  `file://` PDFs work on Chromium once *Allow access to file URLs* is enabled; Firefox never
  grants add-ons file access, so drop the file onto the reader page instead.
- **In-place highlighting** — the sentence being spoken is highlighted with the CSS Custom
  Highlight API (zero DOM mutation, cannot break page layout), with a `<span>` fallback. Lost
  your place? The bar's **↧** button scrolls back to the sentence being read, and lights up by
  itself once that sentence leaves the screen.
- **A bar that never moves, and never goes quiet** — the control bar's size depends on the
  viewport and nothing else. Everything it has to say — loading a voice and how far along it is,
  buffering, a confirmation of what you just changed, an error — appears in a pill *above* the
  bar, so no button ever shifts under the pointer. Every control reports back: change the speed
  and it says so, jump and it names the sentence you landed on.
- **Light, dark, or whatever your system says** — one setting, applied to the reading bar, the
  settings page, the PDF reader and the walkthrough alike.
- **A walkthrough on first run** — five short steps that end with Aloud reading the walkthrough
  itself aloud, so the bar is familiar before it appears over something you actually wanted to
  read. Reopen it any time from the settings page; a one-time card above the bar names the
  controls the first time you read a real page.
- **Picks up where you left off** — close a long article halfway and reopening it lands on the
  sentence you stopped at, with a one-click "Start over". The position is checked against the
  sentence's text, so an edited page never resumes in the wrong place; it is stored on this
  device only and can be cleared from the settings page.
- **Word by word** — with Piper and Kokoro voices the word being spoken is marked inside the
  sentence, timed from the voice model's own phoneme durations rather than estimated.
- **Highlights and notes on any page** — select text and press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>
  (or use the colour toolbar, or right-click → *Highlight and keep in Notes*). The passage is
  highlighted, kept with your note and tags, and highlighted again whenever you come back —
  anchored by its text, so it survives the page being edited around it. While Aloud reads, the
  same key (or the bookmark on the bar) keeps the sentence you just heard. The Library lists every
  note, filters by site and tag, opens each one scrolled to its place on the page, and exports
  what you filtered as Markdown or JSON.
- **Drifted off?** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd> (or <kbd>B</kbd> on the bar)
  goes back about ten seconds and shows you where that is.
- **A Library to come back to** — *Continue* lists what you stopped part-way through with how
  much is left, *Up next* is the reading queue with listening times, and *History* keeps how far
  you got in everything, all on this device.
- **Save as MP3** — the whole page or PDF as one audio file, in the voice and speed you chose.
- **Mark up PDFs** — highlight, underline, strike through and comment on the page itself, and
  save the marks into the PDF file.
- **Speed control for every player** — the same keyboard control for any `<video>` or `<audio>` on
  the web, not just Aloud's own reading: <kbd>D</kbd> / <kbd>S</kbd> step the speed, <kbd>G</kbd>
  jumps to your preferred speed, <kbd>R</kbd> goes back to 1×, and <kbd>Shift</kbd> with D or S
  steps through your presets — all rebindable. The speed is remembered per site, re-applied when a
  player resets it between videos, and shown briefly on the video. It starts with
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> and asks for no permissions; sites you list in
  settings start it by themselves, one granted site at a time.
- **Offline & private** — models download once from Hugging Face and are cached on the device.

## Which voice to use

This is the one thing that differs meaningfully by browser, because it comes down to whether the
extension's Worker can reach the GPU:

| | Piper | Kokoro-82M | Supertonic-2 |
|---|---|---|---|
| **Chromium desktop** | fast | **best — runs on WebGPU** | good |
| **Firefox desktop** | **best choice — fast** | works, ~3× slower than real time | roughly real time |
| **Firefox desktop, WebGPU switched on** | fast | **best — faster than Piper** | good |
| **Firefox Android** | **the only sensible choice** | too slow | too large |

Firefox ships WebGPU switched off, and extensions get no `SharedArrayBuffer`
([bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)), so ONNX Runtime is stuck
on a single WASM thread there by default. Aloud compensates with a pool of synthesis workers, and
Piper is the comfortable default. On Chromium the GPU path makes Kokoro both the best sounding
option and a fast one.

**Firefox users can have the GPU path too.** In `about:config`, set
`dom.webgpu.enabled` and `dom.webgpu.workers.enabled` to `true` (the second one is the one that
matters — synthesis runs in a worker), plus `gfx.webrender.all` if hardware acceleration is off
on your machine, then restart. Kokoro then loads on `webgpu/fp32` and runs faster than Piper.
These are experimental settings; set them back to `false` if Firefox misbehaves, and Aloud
returns to the CPU path on its own. The settings page spells the prefs out, copies them for you,
and re-checks — it asks a real synthesis worker whether it has a GPU rather than assuming from
the browser name, so what it tells you is what your machine actually does. The first GPU run
downloads Kokoro's full-precision model (~320 MB) once.

The options page tells you which of these applies to your machine; you never have to remember
this table.

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

Installing opens the **walkthrough** — five steps, including a live demo that reads the page
itself aloud. Then open an article and click the **Aloud** toolbar button (or press
`Alt+Shift+R`). The first run downloads the voice; after that it works offline. Right-click gives
**Read selection aloud** and **Read from here**. Settings — theme, engine, voice, speed,
highlight colour, cached-model management — are on the extension's options page, which also
reopens the walkthrough.

## How it works

The synthesis engine runs in a **Web Worker at the extension origin**, not in the content script.
That is the load-bearing decision: the Worker gets the extension's CSP (`wasm-unsafe-eval`)
regardless of what the host page's CSP allows, and a lifetime tied to the tab rather than the
~30 s idle eviction that both browsers apply to background contexts.

The Worker is created by a hidden `synth-host.html` iframe rather than directly by the content
script, because Firefox forbids a content script from constructing a `moz-extension://` Worker.
Chromium would allow it, but routing both through the iframe keeps one code path.

The iframe owns a **pool** of those Workers, fed from a single queue: one sentence per idle
worker, so the reader's opening burst of requests spreads across the pool instead of queueing up
behind worker 0. How many workers there are is decided by *probing* for a GPU adapter rather than
by which browser this is — Chromium exposes `navigator.gpu` on machines that then hand back no
adapter at all, and treating those as GPU machines is what used to leave Kokoro running on one
worker there.

The content script keeps all the DOM work — extraction, sentence planning, highlighting, audio
scheduling — and the background is a thin coordinator that injects on `activeTab`, enforces one
active session at a time, and hands PDF bytes to the reader page.

Everything that genuinely differs between browsers is a named capability in
[`src/shared/browser-env.ts`](src/shared/browser-env.ts), so the rest of the code reads
`if (caps.workerWebGPU)` rather than `if (Firefox)`.

Full rationale: [`docs/DESIGN.md`](docs/DESIGN.md). Build details: [`BUILD.md`](BUILD.md).

## Licence

**GPL-3.0-or-later** — because eSpeak-NG (the phonemizer) is GPLv3. See
[`THIRD_PARTY.md`](THIRD_PARTY.md) for every bundled component and every voice's dataset licence.
