# Offline TTS Firefox Extension — Technical Design & Implementation Plan

## Context

Goal: a Firefox (Manifest V3) extension that reads web articles aloud, entirely offline, faster
and higher quality than "Read Aloud". Pipeline: Readability extraction → sentence segmentation →
local neural TTS (Piper by default, Kokoro optional) via ONNX Runtime Web (WASM) → gapless Web
Audio playback → in-place sentence highlighting via the CSS Custom Highlight API.

This document is the senior-architect analysis of the stack's pitfalls in a Firefox MV3 extension,
followed by a concrete build plan. The sections below are the original plan; the extension has
since been built against it.

---

## Implementation notes (as built)

Where the shipped code deviates from the plan below, and why:

1. **Content script is a WXT *unlisted script* (`src/entrypoints/reader-inject.ts`)** injected with
   `browser.scripting.executeScript` on `activeTab`, not a `registration: 'runtime'` content
   script. Result: the manifest requests **no `<all_urls>` host permission** at all.
2. **The worker is built by a standalone Vite build** (`scripts/build-worker.mjs` →
   `public/tts-worker.js`), not a WXT entrypoint, so its output format (ES-module worker) and
   externals are fully controlled.
3. **`onnxruntime-web` / `onnxruntime-common` are external to the worker bundle.** Bundling them
   makes Vite base64-inline ORT's ~33 MB of `.wasm` (a 119 MB bundle was observed). Instead
   `ort.bundle.min.mjs` is vendored to `vendor/ort/` and loaded at runtime by URL
   (`src/engine/ort-loader.ts`); Rollup `output.paths` rewrites the transformers bundle's
   `import "onnxruntime-web"` to that same file, and `globalThis[Symbol.for('onnxruntime')]` is
   set, so Piper and Kokoro share **one** ORT instance and one set of WASM files.
4. **eSpeak-NG is inlined (base64) inside the `phonemizer` npm package** — there is no separate
   `vendor/espeak/`. It still makes the extension GPLv3.
5. **Kokoro's per-voice `.bin` style vectors** are fetched by `kokoro-js` through the Cache API
   (`kokoro-voices`), the one download that doesn't pass through the extension's IndexedDB store.
   The Kokoro model + tokenizer *do* go through IndexedDB via `env.customCache`.
6. **No `vendor/ort-hf/`** — the API-compatible single ORT instance (item 3) serves both engines.
7. **`strict_min_version` is 142** (native CSS Custom Highlight API + WebGPU + Android
   `data_collection_permissions`). The `<span>` highlight fallback is retained regardless.
8. **Highlighting drives off the Readability *text*, fuzzy-aligned to a live-DOM `TextIndex`**
   (`src/align/fuzzy-align.ts` + `src/extract/text-index.ts`), exactly as planned — sentences that
   can't be located are still spoken, just not highlighted.
9. **First playback requires the in-bar Play click** (a real user gesture) because the toolbar
   activation gesture does not survive the message hop to the content script; extraction and
   model download start immediately on activation so they overlap with the user reaching for Play.

Pure-logic modules (`normalize`, `sentences`, `fuzzy-align`, `text-index`) have vitest coverage
(`pnpm test`). The audio pipeline, WASM execution and highlighting need a real Firefox — see
`BUILD.md` for the manual test procedure.

### Decisions locked in with the user
- **Default engine: Piper VITS.** Kokoro-82M ships as an optional "high quality" engine.
- **Highlighting: CSS Custom Highlight API** (`CSS.highlights` + `Highlight` + `Range`), with a
  span-injection fallback for Firefox < 140.
- **Licensing: GPLv3 accepted.** eSpeak-NG (GPLv3) is bundled as the phonemizer.
- **Injection: on activation only.** No declared content scripts; inject with `scripting.executeScript`
  on toolbar-button / context-menu activation. Uses `activeTab`.

---

## 1. Stack pitfalls in Firefox MV3 (the analysis you asked for)

### 1.1 Background: Firefox event pages vs. Chrome service workers vs. Offscreen documents

- **Firefox does not implement the `offscreen` API and has no near-term plan to.** The W3C
  WebExtensions proposal (w3c/webextensions#170) is still open; Chrome-only today.
- Firefox's MV3 background is an **event page**: a real DOM document (`background.html`), so it
  *does* have `AudioContext`, `Audio`, `document`, `DOMParser`, `fetch`, `caches`, IndexedDB,
  `Worker`. Chrome's service-worker limitations (no DOM, no `AudioContext`) **do not apply**.
  So the Chrome pattern "spin up an offscreen document to play audio" is unnecessary here — but
  writing a cross-browser extension later means you'd need `offscreen` on Chrome and an event
  page on Firefox behind a capability check. Out of scope for v1 (Firefox-only).
- **The real Firefox problem is event-page suspension.** The event page is torn down after
  ~30s idle. Anything long-running (a 20-minute article read) must **not** live only in the
  event page. Mitigations, in order of preference:
  1. **Do not run the engine in the event page at all.** Run synthesis + playback in a
     content-script-owned context (below). The event page stays a thin coordinator.
  2. A connected `runtime.Port` from the content script keeps the event page alive while open —
     usable as a fallback keepalive, but fragile; don't depend on it for the audio path.
- **Conclusion:** the audio engine lives in the **content script's page context + a Worker it
  spawns**, not in the background page.

### 1.2 WASM execution & CSP

- MV3 default CSP for extension pages is `script-src 'self'` — **WASM is blocked**. Must declare:
  `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`.
- **Content scripts execute in an isolated world but WASM compilation from a content script is
  governed by the *host page's* CSP in Firefox.** A news site with `script-src 'self'` (no
  `wasm-unsafe-eval`) will break `WebAssembly.instantiate` called directly from the content
  script. **Fix:** never run WASM in the content script itself. Spawn a **Worker from a
  `moz-extension://` URL**; that Worker has the *extension's* origin and the *extension's* CSP
  (which allows `wasm-unsafe-eval`), regardless of the host page. This is the single most
  important architectural constraint and it dictates the module layout in §2.
- ONNX Runtime Web by default fetches its `.wasm`/`.mjs` from a jsDelivr CDN. That is blocked by
  both `script-src 'self'` and the absence of a CDN in `connect-src`. **All ORT assets must be
  bundled and `ort.env.wasm.wasmPaths` pointed at `runtime.getURL(...)`.** Same for the eSpeak-NG
  `.wasm` + `.dat`, the AudioWorklet module (if used), and the model files if bundled.

### 1.3 SharedArrayBuffer / threads — the hard performance ceiling

- **`SharedArrayBuffer` is unavailable in Firefox extension pages, content scripts, and their
  Workers.** Bug 1673477 ("Enable crossOriginIsolated and SharedArrayBuffer for extension
  pages") is REOPENED and, per Mozilla, "far away" — it needs per-extension process isolation
  first. Manifest `cross_origin_embedder_policy` / `cross_origin_opener_policy` keys are not
  honored. A content script only gets SAB if the *host page itself* is cross-origin isolated,
  which almost no article page is.
- **Consequences:**
  - ONNX Runtime Web must run **single-threaded**: `ort.env.wasm.numThreads = 1`. No thread
    pool, no `ort-wasm-threaded` benefit. SIMD is still available and must be kept on
    (`ort.env.wasm.simd = true`).
  - No SAB-backed lock-free ring buffer between the synthesis Worker and an AudioWorklet.
    Audio must move by **`postMessage` with transferable `ArrayBuffer`s** (a copy, cheap at TTS
    data rates) — or we avoid AudioWorklet entirely (see §1.5).
  - `ort.env.wasm.proxy = true` (ORT's own worker offload) still works — it uses `postMessage`,
    not SAB — but it's redundant since we already own a Worker; keep `proxy = false` and call
    ORT directly inside our Worker.
- **Escape hatch: WebGPU.** Firefox shipped WebGPU (141+, broadening through 2025–26) and
  `navigator.gpu` is exposed in Workers. ORT's `webgpu` EP (JSEP build) does not need SAB.
  Treat it as **progressive enhancement**: try `webgpu`, fall back to `wasm`. Expect a 1–3s
  one-time shader-compile cost — warm it during model load. WebGPU in the extension Worker on
  Firefox is still comparatively new; the `wasm` path is the correctness baseline and must
  always work.

### 1.4 CORS & model download

- Hugging Face model URLs (`https://huggingface.co/<repo>/resolve/<rev>/<file>`) 302-redirect to
  `cdn-lfs.hf.co` / Xet with `Access-Control-Allow-Origin: *`. A plain `fetch` from a Worker
  succeeds without any special handling — this is exactly how transformers.js works from web
  pages.
- Still declare `host_permissions` for `https://huggingface.co/*`, `https://*.hf.co/*`,
  `https://cdn-lfs*.huggingface.co/*` — it removes CORS from the equation entirely for
  extension-context fetches and future-proofs against HF tightening headers. Provide a
  self-hosted mirror URL in config as a backstop.
- **Do downloads from a context that won't be suspended mid-transfer.** The event page can die
  during an 80MB download. Options: (a) download **inside the synthesis Worker** (owned by the
  content script, lives as long as the tab session) — preferred; (b) if download must be
  cross-tab-shared, use `navigator.locks` ("model-dl-<id>") so two tabs don't fetch the same
  model twice, and stream to IndexedDB as chunks arrive.
- **Integrity:** pin `(repo, revision, filename, sha256, byteLength)` per asset in a bundled
  manifest JSON. Verify SHA-256 (`crypto.subtle.digest`) after download, before first use.
- **transformers.js caching quirk (Kokoro path):** kokoro-js/transformers.js default cache is
  the **Cache API** (`caches.open('transformers-cache')`), which works in the extension origin
  but is opaque and hard to show progress for. Override: set `env.allowRemoteModels`,
  `env.useBrowserCache = false`, and implement `env.customCache` as a thin adapter over our own
  IndexedDB store, OR set `env.localModelPath` to `runtime.getURL(...)` and feed it files we
  already fetched. Piper path is hand-rolled ORT so we control this fully.

### 1.5 AudioWorklet quirks — and why we mostly avoid it

- `audioWorklet.addModule(url)` needs `url` to be a `moz-extension://` `web_accessible_resource`.
  The worklet's `AudioWorkletGlobalScope` is a separate realm — no `postMessage` transferables
  of large buffers without SAB means you'd copy every 128-sample render quantum over the port.
  Clumsy and jittery for our use case.
- **Autoplay policy:** an `AudioContext` starts `suspended`. `.resume()` must be called inside a
  real user-gesture handler. Our gesture is the toolbar-button click / the in-page play button.
  Since playback lives in the content script, the gesture and the `resume()` are co-located —
  fine. If the first activation is via context menu or keyboard command, we still get a gesture.
- **Chosen design: no AudioWorklet.** For gapless playback we use **`AudioBufferSourceNode`
  scheduling**: synthesize each chunk to `Float32Array` PCM → `ctx.createBuffer` → 
  `src.start(startTime)` where `startTime` accumulates exact `buffer.duration` values. This is
  sample-accurate, needs no SAB, no worklet module, and no custom-stream bookkeeping. An
  `AnalyserNode` can still hang off the graph for a waveform UI. A `GainNode` gives us
  fade-in/out on pause so it doesn't click.
- AudioWorklet is only reconsidered if we later need true streaming synthesis (model emitting
  audio faster-than-realtime in sub-sentence frames). Not needed for Piper/Kokoro per-sentence.

### 1.6 Readability pitfalls

- `Readability` **mutates the DOM it is given**. Always run it on a clone:
  `new Readability(document.cloneNode(true)).parse()`. Use `isProbablyReaderable(document)` as a
  pre-check to decide whether to offer "article mode" vs "read full page / selection".
- Its output (`article.content`) is a **detached, sanitized HTML string**. Character offsets in
  it **do not map back to live DOM nodes**, so you cannot drive in-place highlighting from
  Readability output directly. Two text domains must be kept separate:
  - **What to speak** — derived from Readability (clean, no nav/ads/footers).
  - **What to highlight** — must come from a walk of the *live* DOM.
  Bridge: after Readability identifies the article, locate the best-matching **live container
  element** (heuristic: the element whose `textContent` has the highest similarity / longest
  common subsequence with `article.textContent`; usually `<article>`, `[role=main]`, or the
  Readability-scored top candidate re-found in the live tree). Then build the highlight index by
  `TreeWalker` over *that live element's* text nodes only.
- Pages that lazy-load / re-render (SPA news sites, infinite scroll) can invalidate the live
  container after extraction. Guard with a `MutationObserver` on the container; on structural
  change, re-resolve ranges by text search rather than cached `Range` objects.
- Won't work on `about:`, `view-source:`, the PDF.js viewer, AMO, or `file://` without opt-in.
  Detect and show a friendly "can't read this page" state.

### 1.7 Other Firefox-specific gotchas

- **`web_accessible_resources` must list every runtime-loaded asset** (ORT `.wasm`/`.mjs`,
  eSpeak `.wasm`/`.dat`, model files if served from the package, any worklet). In MV3 the entry
  is `{ resources: [...], matches: ["<all_urls>"] }`. This does expose those URLs to pages (minor
  fingerprinting surface) — acceptable.
- **`activeTab` + `scripting.executeScript`**: the content script is injected fresh each
  activation. It must be idempotent (guard against double-injection with a `window.__ttsLoaded`
  flag) and must fully tear down (Worker.terminate, AudioContext.close, highlight cleanup,
  observers disconnected) on stop / tab navigation (`pagehide`).
- **IndexedDB in private windows** is ephemeral / may be blocked. Detect and fall back to
  in-memory (re-download per session) with a warning.
- **Storage quota:** request `"unlimitedStorage"` permission; still handle `QuotaExceededError`
  by evicting old model revisions.
- **`Intl.Segmenter`** (sentence segmentation) is available in Firefox 125+. Safe to rely on.
- **`browser.*` vs `chrome.*`**: use `browser.*` promised API + `webextension-polyfill` only if
  we later go cross-browser. Firefox-only v1 → `browser.*` directly.
- **AMO review:** GPLv3 source must be published with reproducible build instructions; bundled
  minified libraries (ORT, Readability, kokoro-js) and WASM blobs must be documented with exact
  versions and build provenance or AMO will reject. Keep a `THIRD_PARTY.md` + `build.md`.
- **Model licensing:** Kokoro-82M weights are Apache-2.0. Piper voices vary per-voice (MIT /
  CC0 / ODC / some non-commercial) — curate an allowlist of redistributable voices and record
  each voice's license in the voice manifest.

---

## 2. Target architecture

```
┌────────────────────────── Background event page (thin coordinator) ──────────────────────────┐
│ • browser.action.onClicked / contextMenus / commands → scripting.executeScript(content.js)   │
│ • settings + voice/engine selection persistence (browser.storage.local)                      │
│ • single-active-session registry: when tab B starts, message tab A to stop                   │
│ • "which tabs can't be injected" UX routing                                                  │
│ • NO audio, NO inference, NO large downloads                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                      │ scripting.executeScript                    ▲ runtime.sendMessage (state)
                      ▼                                            │
┌────────────────────────────── Content script (per activated tab) ────────────────────────────┐
│ page-context, isolated world, HAS DOM — NO WASM here                                         │
│ • Extraction: Readability on document.cloneNode(true) + live-container resolution            │
│ • Segmentation: Intl.Segmenter(sentence) → clause sub-split for latency bound                │
│ • Highlight index: TreeWalker over live container → global char offsets ⇄ Range map          │
│ • Highlighter: CSS.highlights.set('tts-active', new Highlight(range)) (+ span fallback)       │
│ • Audio: AudioContext, GainNode, gapless AudioBufferSourceNode scheduler                     │
│ • Playback UI: shadow-DOM control bar (play/pause, speed, voice, progress, close)            │
│ • Owns and supervises the Synthesis Worker; applies backpressure                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                      │ postMessage({sentenceId, text, voice, speed})
                      ▼                                            ▲ postMessage({sentenceId, pcm:ArrayBuffer, sampleRate, [wordTimings]})
┌────────────────────────────── Synthesis Worker (moz-extension origin) ───────────────────────┐
│ EXTENSION CSP → wasm-unsafe-eval allowed. Spawned from runtime.getURL('worker.js')           │
│ • Model store: IndexedDB (extension origin, shared across tabs), navigator.locks for dl      │
│ • First run: fetch model+config+voices from HF (CORS-open) → sha256 verify → IndexedDB       │
│ • G2P: eSpeak-NG WASM (phonemes + optional phoneme durations)                                │
│ • Inference: onnxruntime-web, numThreads=1, SIMD on; EP = webgpu?→wasm fallback              │
│ • Piper: hand-rolled ORT session (phoneme_ids → audio). Kokoro: kokoro-js/transformers.js    │
│ • Output: Float32 PCM + sampleRate; emits progress events for model download                 │
│ • Queue: synthesize N+lookahead ahead of playhead; pause on backpressure signal              │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Why the Worker is spawned by the content script, not the background page
- It inherits the **extension origin + extension CSP** → WASM runs regardless of host-page CSP.
- Its lifetime is tied to the tab session, not the 30s event-page idle timer.
- IndexedDB is keyed by the extension origin, so the model cache written by tab A's Worker is
  visible to tab B's Worker — no duplication on disk (RAM is still per-Worker; §2.3).

### 2.2 The gapless pipeline (no pauses between sentences)

- **Segmentation** produces an ordered list of chunks. Each chunk ≤ ~240 chars; long sentences
  are split at `; : — ,` boundaries so first-audio latency and re-synth-on-seek stay bounded.
- **Producer (Worker):** maintains `synthAhead` — keep chunks `[playIdx … playIdx + LOOKAHEAD]`
  synthesized (LOOKAHEAD = 2 default, 3 on fast machines measured by first-chunk RTF).
  Backpressure: stop when `buffered_audio_seconds > 20` OR `chunks_ahead > 4`; resume on drain.
- **Consumer (content script):** an explicit scheduler, not `onended` chaining alone:
  - `nextStartTime` starts at `ctx.currentTime + 0.12` (small priming gap, once).
  - For each ready chunk in order: `src = ctx.createBufferSource(); src.buffer = buf;
    src.connect(gain); src.start(nextStartTime); nextStartTime += buf.duration / speed;`
  - `src.onended` → advance `playIdx`, fire highlight for the *next* chunk slightly early
    (compensate perceived latency ~40ms), request Worker to top up `synthAhead`.
  - If a chunk isn't ready when `nextStartTime - ctx.currentTime < 0.25`, insert a tiny silent
    buffer and re-check (graceful underrun) instead of clicking.
- **Speed control:** prefer **model-level** (`length_scale` for Piper, `speed` for Kokoro) so
  pitch is preserved; re-synth pending chunks on change. `playbackRate` on already-scheduled
  buffers only as an instant-but-temporary bridge.
- **Pause:** `gain.gain.setTargetAtValue(0, now, 0.015)` then `ctx.suspend()` (no click).
  Resume mirrors it. **Skip forward/back:** stop scheduled sources, set `playIdx`, clear
  `nextStartTime`, tell Worker to refocus its queue on the new index.

### 2.3 Multi-tab behavior
- One active playback session globally. Background keeps `activeSessionTabId`. Starting in a new
  tab sends `STOP` to the previous tab (full teardown, `Worker.terminate()`, frees ~150–350MB
  RAM). Non-active tabs keep their content script only if paused-and-parked; default is teardown.

### 2.4 Highlighting detail
- Build once after extraction: flatten the live container's visible text nodes into a single
  logical string with `[node, startOffset]` breakpoints (skip `display:none`,
  `visibility:hidden`, `<script>/<style>`, `aria-hidden`).
- Map each speech chunk to a `[globalStart, globalEnd)` slice of that string (fuzzy-align the
  normalized spoken text to the raw text to absorb normalization differences — numbers,
  whitespace, soft hyphens).
- Per chunk, lazily build a `Range` spanning the mapped nodes; `CSS.highlights.set('tts-active',
  new Highlight(range))`. Style via `::highlight(tts-active) { background: …; color: … }` in a
  stylesheet injected into the page (adoptedStyleSheets). Zero DOM mutation → no reflow, cannot
  break layout.
- **Word-level highlight (stretch):** Kokoro can expose per-token durations; eSpeak-NG gives
  per-phoneme durations for Piper. If available, sub-divide the chunk range on a timer synced to
  `ctx.currentTime`. Ship sentence-level first.
- Auto-scroll: `range.getBoundingClientRect()` → if outside viewport, `scrollIntoView({block:
  'center', behavior: prefers-reduced-motion ? 'auto' : 'smooth'})`, throttled to ≤ 1/600ms.
- Fallback (FF < 140, no `CSS.highlights`): `Range.surroundContents` with a `<span
  class="tts-hl">`, unwrap on advance; accept rare inline-split edge cases.

---

## 3. Repository layout

```
/  (WXT project — WXT has first-class Firefox MV3 + web_accessible_resources handling)
├── wxt.config.ts
├── entrypoints/
│   ├── background.ts            # event page: routing, settings, session registry
│   ├── content.ts               # injected on activation; extraction+audio+highlight+UI
│   └── worker.ts                # synthesis Worker (bundled to a WAR)
├── src/
│   ├── extract/
│   │   ├── readability.ts       # clone + parse + isProbablyReaderable
│   │   └── liveContainer.ts     # resolve live DOM container, build text-node index
│   ├── segment/
│   │   ├── sentences.ts         # Intl.Segmenter + clause sub-split
│   │   └── normalize.ts         # numbers, dates, currency, acronyms, URLs/emails skip
│   ├── audio/
│   │   ├── scheduler.ts         # gapless AudioBufferSourceNode scheduler
│   │   └── controls.ts          # gain fades, pause/resume/seek
│   ├── highlight/
│   │   ├── highlighter.ts       # CSS Custom Highlight API + span fallback
│   │   └── ranges.ts            # global-offset ⇄ Range mapping, fuzzy align
│   ├── engine/
│   │   ├── protocol.ts          # typed messages content ⇄ worker
│   │   ├── modelStore.ts        # IndexedDB CRUD, sha256 verify, navigator.locks, quota
│   │   ├── download.ts          # HF fetch w/ progress, mirror fallback
│   │   ├── g2p/espeak.ts        # eSpeak-NG WASM wrapper (phonemes [+durations])
│   │   ├── piper.ts             # ORT session, phoneme_ids→PCM, length_scale
│   │   ├── kokoro.ts            # kokoro-js wrapper, customCache→modelStore, speed
│   │   └── ort.ts               # ORT env setup: wasmPaths, numThreads=1, EP select
│   └── ui/
│       └── controlBar.ts        # shadow-DOM playback bar
├── assets/
│   ├── ort/                     # ort-wasm-simd-threaded.{wasm,mjs} + .jsep.{wasm,mjs}
│   ├── espeak/                  # espeakng.{wasm,js} + espeak-ng-data*
│   └── models/manifest.json     # {engine,voice}→{repo,rev,file,sha256,bytes,license}
├── THIRD_PARTY.md  build.md  LICENSE(GPL-3.0)
```

Pinned dependency versions are chosen at Step 1 and recorded in `THIRD_PARTY.md`
(onnxruntime-web, @mozilla/readability, kokoro-js, @xenova/transformers, espeak-ng WASM build).

---

## 4. Manifest (key entries)

```jsonc
{
  "manifest_version": 3,
  "name": "…", "version": "0.1.0",
  "background": { "scripts": ["background.js"], "type": "module" },
  "permissions": ["activeTab", "scripting", "storage", "unlimitedStorage",
                  "contextMenus", "tabs"],
  "optional_permissions": ["<all_urls>"],
  "host_permissions": ["https://huggingface.co/*", "https://*.hf.co/*",
                       "https://cdn-lfs*.huggingface.co/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "web_accessible_resources": [{
    "resources": ["worker.js", "assets/ort/*", "assets/espeak/*", "assets/models/*"],
    "matches": ["<all_urls>"]
  }],
  "action": { "default_title": "Read aloud" },
  "commands": { "toggle-read": { "suggested_key": { "default": "Alt+R" } } },
  "browser_specific_settings": { "gecko": { "id": "tts@…", "strict_min_version": "128.0" } }
}
```

---

## 5. Step-by-step implementation plan

Each step ends in something runnable / testable. **Stop for approval after this document.**

### Step 0 — Project scaffold
- `npm create wxt@latest`, Firefox MV3 target, TS, ESLint/Prettier.
- Manifest as §4. `web-ext run` launches a dev Firefox.
- Stub `background.ts` (logs activation), `content.ts` (injects a "hello" shadow-DOM bar on
  toolbar click via `scripting.executeScript`), verify injection + teardown on `pagehide`.
- **Verify:** click toolbar button on a news article → bar appears; navigate away → bar/listeners gone.

### Step 1 — Vendoring & ORT smoke test
- Add pinned deps. Copy ORT `.wasm`/`.mjs` (incl. `.jsep`) and eSpeak-NG WASM+data into `assets/`.
- `engine/ort.ts`: `env.wasm.wasmPaths = { … runtime.getURL }`, `numThreads=1`, `simd=true`,
  EP probe (`navigator.gpu` present → try `webgpu`, else `wasm`).
- `worker.ts`: on load, create a trivial ORT `InferenceSession` from a tiny bundled test ONNX
  (add-two-tensors) and post the result back.
- **Verify:** content script spawns Worker, Worker runs ORT with **no CSP error on a site whose
  own CSP is `script-src 'self'`** (test on github.com or a bank site). Confirm single-thread,
  confirm `crossOriginIsolated === false` and code path doesn't request threads.

### Step 2 — Model store & download
- `modelStore.ts`: IndexedDB schema `models{ key, engine, voice, rev, blob, sha256, bytes,
  installedAt }`; `navigator.locks` around downloads; quota-exceeded eviction of stale revs;
  private-window detection → in-memory fallback.
- `download.ts`: streaming `fetch` from HF `resolve` URL with progress events; SHA-256 verify;
  mirror-URL fallback; resumable-ish (restart chunk on failure).
- `assets/models/manifest.json`: default Piper voice (e.g. `en_US-*` medium), its `.onnx` +
  `.onnx.json`, eSpeak data; Kokoro entry (int8 model + voices).
- Wire a first-run progress UI in the control bar.
- **Verify:** fresh profile → activate → downloads default Piper voice once with a progress bar,
  survives an event-page suspension (idle 60s mid-download), second tab reuses cache (no
  re-download), hash mismatch is rejected.

### Step 3 — Piper synthesis (single sentence)
- `g2p/espeak.ts`: init eSpeak-NG WASM with bundled data; `textToPhonemes(text, voice-lang)` →
  IPA/eSpeak phonemes; map to Piper `phoneme_id_map` from `.onnx.json`; insert BOS/EOS/pad.
- `piper.ts`: build input tensors (`input`, `input_lengths`, `scales=[noise, length, noise_w]`),
  run session, get Float32 PCM @ 22050 Hz.
- Worker message `SYNTH_ONE` → returns `{pcm, sampleRate}`.
- Content script: on play, synthesize just sentence 0, play it through a bare AudioContext.
- **Verify:** click play on an article → first sentence speaks, intelligible, correct speed;
  measure real-time factor (RTF) and first-audio latency; log both.

### Step 4 — Extraction + segmentation + highlight index
- `extract/readability.ts`: clone+parse; `isProbablyReaderable` gating; expose `title`,
  `textContent`, `content`.
- `extract/liveContainer.ts`: resolve best live container; `TreeWalker` visible-text index →
  logical string + breakpoints.
- `segment/sentences.ts` + `normalize.ts`: chunk list with `[globalStart,globalEnd)` per chunk,
  fuzzy-aligned to raw text.
- `highlight/highlighter.ts`: `CSS.highlights` path + span fallback; adoptedStyleSheet for
  `::highlight(tts-active)`; throttled auto-scroll; `prefers-reduced-motion`.
- **Verify:** on 5–10 varied sites (news, blog, docs, Wikipedia, Substack, MDN) — extracted text
  excludes nav/ads/footer; stepping a debug "next sentence" button highlights the right text
  in-place with no layout shift; SPA re-render doesn't desync (MutationObserver re-resolve).

### Step 5 — Gapless pipeline
- `audio/scheduler.ts` + `audio/controls.ts`: the §2.2 scheduler, GainNode fades, underrun
  silent-buffer handling.
- Worker producer loop: lookahead synth, backpressure protocol in `engine/protocol.ts`.
- Content orchestrator: bind scheduler advance → highlight advance → Worker top-up; pause/resume/
  seek/speed.
- **Verify:** read a 1000-word article start to finish — **no audible gap** between sentences
  (spectrogram check + listening), highlight tracks within ~150ms, pause/resume click-free,
  skip ±1 sentence works, speed 0.75×–2× via model re-synth keeps pitch. Test on a slow CPU
  (throttle) — graceful underruns, no crash.

### Step 6 — Control bar UX + settings + multi-tab
- Full shadow-DOM control bar: play/pause, ±sentence, speed, voice/engine picker, progress
  scrubber (seek to sentence), close. Keyboard shortcut. Position bottom, non-intrusive,
  theme-aware, draggable.
- `background.ts` session registry: single active session, stop-previous-tab.
- Settings page: engine (Piper/Kokoro), default voice, speed, highlight color, auto-scroll,
  download management (list/delete cached models, storage used).
- **Verify:** start in tab A, start in tab B → A stops and frees RAM (check about:memory);
  settings persist; deleting a model frees IndexedDB.

### Step 7 — Kokoro optional engine
- `kokoro.ts`: kokoro-js with `env.useBrowserCache=false` + `customCache` adapter → `modelStore`;
  `dtype:'q8'`, `device:'webgpu'|'wasm'`; `generate(text, {voice, speed})` → PCM @ 24000 Hz.
- Same Worker protocol; engine switch re-inits.
- WebGPU probe + warmup + wasm fallback; surface which EP is active in settings.
- **Verify:** switch to Kokoro → downloads once, synthesizes, gapless pipeline unchanged, WebGPU
  path works on a supported GPU and falls back cleanly when `navigator.gpu` is absent.

### Step 8 — Hardening & release prep
- Non-injectable pages (`about:`, PDF viewer, AMO, `file://`) → clear messaging.
- "Read selection only" and "read from here" (context menu) modes.
- Error surfaces: download failure, OOM, model corruption (auto re-download on hash fail).
- Perf pass: measure RTF/latency/RAM for Piper+Kokoro on low/mid/high hardware; tune LOOKAHEAD,
  chunk size, backpressure thresholds.
- A11y: control bar ARIA + focus management; respect reduced motion; high-contrast highlight.
- Locale: verify eSpeak language selection per voice; basic non-English article support.
- `THIRD_PARTY.md`, `build.md` (reproducible build), `LICENSE` GPL-3.0, curated voice license
  table. AMO listing draft.
- **Verify:** `web-ext lint` clean; fresh-profile end-to-end on Windows + Linux + macOS Firefox
  release + ESR; `web-ext build` artifact installs and runs offline (airplane mode after first
  model download).

---

## 6. Key risks & fallbacks (carry through every step)

| Risk | Mitigation / fallback |
|---|---|
| Single-thread WASM too slow for Kokoro on low-end CPU | Piper is default; Kokoro gated behind a "your device may be slow" check using measured RTF; WebGPU when available |
| Host-page CSP blocks WASM | Worker runs at extension origin/CSP — never run WASM in content script (validated Step 1) |
| Event page suspended mid-download | Download in the Worker (tab-session lifetime), `navigator.locks`, resumable chunks |
| `CSS.highlights` missing (FF < 140) | Span-injection fallback with unwrap-on-advance |
| Readability offsets don't map to live DOM | Separate "speak text" vs "highlight text"; fuzzy-align to a live-DOM TreeWalker index |
| SPA re-renders invalidate ranges | MutationObserver on container → re-resolve by text search, not cached Range |
| HF CORS / rate limiting | `host_permissions` + self-hosted mirror URL in manifest |
| WebGPU in extension Worker unstable on Firefox | Progressive enhancement only; `wasm` is always the correctness baseline |
| GPLv3 obligations | Repo public, GPL-3.0 LICENSE, reproducible build docs from day one |
| Multi-tab RAM blowup | Single active session; terminate previous Worker |
| AMO rejects opaque WASM blobs | Document every binary's version + upstream build in `THIRD_PARTY.md`/`build.md` |

## 7. Verification tooling
- `web-ext run` for live dev, `web-ext lint` pre-release.
- Manual test matrix: 10-site extraction set, 3 hardware tiers, FF release + ESR, 3 OSes,
  private window, offline-after-first-download.
- Instrumentation: log RTF, first-audio latency, underrun count, highlight-sync delta, peak RAM —
  gate release on thresholds (first-audio < 1.2s Piper / < 2.0s Kokoro-wasm; zero audible gaps).
- Spectrogram diff (Audacity / `ffmpeg` silencedetect) on a recorded full-article read to prove
  gaplessness objectively.
