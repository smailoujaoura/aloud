# Aloud — Offline Neural Reader

Read any article aloud with a **fully local** neural voice. No servers, no accounts: synthesis,
your notes, your highlights and your reading positions never leave this device.

What *does* go over the network, once each and only when you ask for it: downloading a voice
model, previewing a Piper voice (a short hosted clip), and fetching a page or PDF you told Aloud
to read or queue. A saved article's images stay unfetched until you press "Load images", so
reopening one tells nobody you are reading it.

Runs on **Firefox** (desktop and Android) and **Chromium** (Chrome, Edge, Brave, Opera).

- **Extraction** — [Mozilla Readability](https://github.com/mozilla/readability) strips nav / ads
  and grabs the article text.
- **Voices** — [Piper](https://github.com/rhasspy/piper) (fast, ~21–137 MB per voice: `medium` around 60 MB, `high` around 110),
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
- **Readable on someone else's page** — a highlight is a wash over text Aloud does not control.
  On a dark page the wash becomes paler and fainter (yellow at full strength over black is mud),
  so the page's own light text stays readable; a sentence that would still be hard to read gets
  black or white letters, and everything else keeps the page's colours. While Aloud reads, your
  saved highlights turn into underlines, so the only wash is the sentence being read, and the
  reading bar slides out of the way when you scroll down and keeps the sentence clear of itself.
- **Reads what you see** — only the prose the page shows: a translation collapsed out of sight, a
  styled "Translate?" button or a closed `<details>` is not read, and a passage you reveal while
  listening is read when it is reached — hidden again, it is passed over.
- **Each language in its own voice** — the language of every paragraph is told apart (the page's
  own `lang` markup, the browser's language detector, and the paragraphs around a short reply or
  a name), and each is read by a downloaded voice that speaks it: an Italian story with English
  translations switches between an Italian and an English voice. Pick a voice on the bar during
  a passage to make it that language's voice on every page, lock a page to one voice, or correct
  a passage's language, from the language button on the bar. A language with no voice is said to
  have none — with a link to its voices, or a way to skip it — never quietly read as another.
- **Said the way people say it** — a reply and its attribution (*"No!" he said.*), a run of short
  exclamations, a French reply with its closing guillemet, are each spoken as one utterance, and
  abbreviations such as *Sig.*, *Sra.* or *z. B.* no longer end a sentence.
- **Live words a minute** — beside the speed, the pace of the passage being heard: its words over
  its audio, set as each passage starts and held until the next, so the figure is steady. A speed
  change shows when the first passage made at the new speed begins.
- **Word by word** — with Piper and Kokoro voices the word being spoken is marked inside the
  sentence, timed from the voice model's own phoneme durations rather than estimated. It is shown
  as a darker shade by default; Settings switches it to an underline, or off.
- **Highlights and notes on any page** — select text and press <kbd>K</kbd> (on a page Aloud is
  running on) or <kbd>Alt</kbd>+<kbd>K</kbd>
  (or right-click → *Highlight and keep in Notes*): kept at once, in your default colour and
  style — highlight or underline — with nothing to answer. Click a mark to recolour it, switch
  its style, or write its note by just typing; <kbd>Delete</kbd> removes it. The colours are
  yours to rename and change, and passages kept with a note get their own colour. The passage is
  marked again whenever you come back — anchored by its text, so it survives the page being
  edited around it. While Aloud reads, the same key (or the bookmark on the bar) keeps the
  sentence you just heard.
- **Your notes, on the page** — <kbd>Alt</kbd>+<kbd>N</kbd>, <kbd>Alt</kbd>+<kbd>K</kbd> with
  nothing selected, or right-click → *Show my notes*: a panel listing this page's notes or all of
  them, searchable, each one a click from its place.
- **Your keys** — the shortcuts deliberately avoid <kbd>Alt</kbd>+<kbd>Shift</kbd>+letter, which
  is the chord Firefox gives web pages for their own access keys. Settings → *Shortcuts* shows
  what each key is set to and, on Firefox, sets it to whatever you press.
- **Drifted off?** <kbd>Alt</kbd>+<kbd>,</kbd> (or <kbd>B</kbd> on the bar)
  goes back about ten seconds and shows you where that is.
- **One page for everything** — the Library (*Continue*, *Up next*, *Notes*, *History*, *Statistics*) and every
  setting sit side by side in Aloud's page, one click apart. *Continue* lists what you stopped
  part-way through with how much is left, *Up next* is the reading queue with listening times,
  *Notes* filters by site and tag, exports as Markdown or JSON and imports a notes file back
  (merging, never doubling), *History* keeps how far you got in everything, and *Statistics* shows
  words and time heard, documents finished, by day, site and language — only audio you actually
  heard, never a saved MP3 — all on this device.
- **Backup & restore** — one file with every setting, voice choice, key, colour, note, the queue,
  history, statistics, video speeds and PDF marks. Restoring merges rather than overwrites, then offers to
  download the voices the backup had and to allow the sites that were allowed.
- **Save as MP3** — the whole page or PDF as one audio file, in the voice and speed you chose.
- **Mark up PDFs** — highlight, underline, strike through and comment on the page itself, and
  save the marks into the PDF file.
- **Speed control for every player** — the same keyboard control for any `<video>` or `<audio>` on
  the web, not just Aloud's own reading: <kbd>D</kbd> / <kbd>S</kbd> step the speed, <kbd>G</kbd>
  jumps to your preferred speed, <kbd>R</kbd> goes back to 1×, <kbd>Shift</kbd> with D or S
  steps through your presets, and <kbd>Z</kbd> / <kbd>X</kbd> rewind and skip forward 10 seconds —
  even on players with no seek bar, like YouTube Shorts. All rebindable. The speed is remembered per site, re-applied when a
  player resets it between videos, and shown briefly on the video. It starts with
  <kbd>Alt</kbd>+<kbd>M</kbd> and asks for no permissions; sites you list in
  settings start it by themselves, one granted site at a time.
  On those sites it can also stop video and audio from playing by themselves (off until you
  switch it on): anything you start — a click, a tap, <kbd>Space</kbd> — plays as usual.
- **Offline & private** — models download once from Hugging Face and are cached on the device.

## Which voice to use

What decides it is not the browser but whether the extension's Worker can reach the GPU through
WebGPU. With it, Chromium and Firefox perform the same:

| | Piper | Kokoro-82M | Supertonic-2 |
|---|---|---|---|
| **Chromium or Firefox, with WebGPU** | fast | **best — faster than Piper** | good |
| **Chromium or Firefox, CPU only** | **best choice — fast** | works, ~3× slower than real time | roughly real time |
| **Firefox Android** | **the only sensible choice** | too slow | too large |

Chromium has WebGPU on by default; Firefox turns it on for pages on Windows but not for the
workers Aloud synthesises in (see below). [Using your graphics card](https://aloud.souj.dev/gpu.html)
explains, for readers rather than developers, why turning it on is safe and how to do it in each
browser; Settings → Advanced links to it, and the reader mentions it once when Kokoro or
Supertonic is running on the CPU.

Firefox ships WebGPU switched off, and extensions get no `SharedArrayBuffer`
([bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)), so ONNX Runtime is stuck
on a single WASM thread there by default. Aloud compensates with a pool of synthesis workers, and
Piper is the comfortable default. With WebGPU, in either browser, Kokoro is both the best
sounding option and a fast one.

**Firefox users can have the GPU path too.** In `about:config`, set
`dom.webgpu.enabled` and `dom.webgpu.workers.enabled` to `true` (the second one is the one that
matters — synthesis runs in a worker), plus `gfx.webrender.all` if hardware acceleration is off
on your machine, then restart. Kokoro then runs on the GPU.
These are experimental settings; set them back to `false` if Firefox misbehaves, and Aloud
returns to the CPU path on its own. The settings page spells the prefs out, copies them for you,
and re-checks — it asks a real synthesis worker whether it has a GPU rather than assuming from
the browser name, so what it tells you is what your machine actually does. The GPU path reads
Kokoro's full-precision build, so the first read on a GPU fetches it once: the quantised build
loads on WebGPU but produces noise rather than speech, so the two paths cannot share a file.

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
`Alt+R`, which you can change). The first run downloads the voice; after that it works offline. Right-click gives
**Read selection aloud** and **Read from here**. Settings — theme, engine, voice, speed,
highlight colour, cached-model management — are on the extension's options page, which also
reopens the walkthrough.

## Checking that it speaks

```bash
npm run build:chrome
npm run say -- --engine kokoro --voice af_heart          # writes kokoro-af_heart-cpu.wav
npm run say -- --engine kokoro --voice af_heart --gpu    # the WebGPU path
```

`scripts/say.mjs` captures what a voice actually says into a WAV. It exists because every cheaper
check — the worker replied, audio came back, the right number of samples at the right rate —
passes happily on audio that is not speech: Kokoro's quantised weights load on WebGPU and return
audio of the right length, but what comes out is Mandarin-sounding noise rather than the sentence.
Play the file, or run it through any speech-to-text and see whether the sentence comes back.

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
