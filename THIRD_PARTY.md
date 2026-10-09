# Third-party components

Aloud is distributed under **GPL-3.0-or-later** (see `LICENSE`). The determining factor is
eSpeak-NG, which is GPLv3 and is bundled twice as the grapheme-to-phoneme engine: rhasspy's
eSpeak-NG fork inside `piper_phonemize` for Piper voices (every language), and the English-only
build inside the `phonemizer` package that kokoro-js uses.

## Bundled libraries

| Component | Version | License | How it is used | Where it ends up |
|---|---|---|---|---|
| [eSpeak-NG, rhasspy fork](https://github.com/rhasspy/espeak-ng) in [`piper-phonemize`](https://github.com/rhasspy/piper-phonemize), compiled to WASM | as shipped in [`@diffusionstudio/piper-wasm`](https://github.com/diffusion-studio/piper-wasm) 1.0.0 | **GPL-3.0-or-later** (eSpeak-NG); MIT (piper-phonemize, build wrapper) | Text → IPA phonemes for Piper, in every language eSpeak supports — the phonemiser Piper voices were trained with | `vendor/piper/piper_phonemize.{wasm,data}` (loaded at runtime), glue in `vendor/rt/piper-*.js` |
| [eSpeak-NG](https://github.com/espeak-ng/espeak-ng) (compiled to WASM, inlined in `phonemizer`) | as shipped in `phonemizer` 1.2.1 | **GPL-3.0-or-later** | Text → IPA phonemes for Kokoro (English data only) | `vendor/rt/kokoro-*.js` (base64-inlined WASM + data) |
| [`phonemizer`](https://github.com/xenova/phonemizer.js) | 1.2.1 | Apache-2.0 (wrapper) | eSpeak-NG JS wrapper used by kokoro-js | `vendor/rt/kokoro-*.js` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | 1.22.0 | MIT | Neural network inference (WASM, optionally WebGPU) | `vendor/ort/*` (loaded at runtime) |
| [`kokoro-js`](https://github.com/hexgrad/kokoro) | 1.2.1 | Apache-2.0 | Kokoro engine wrapper | `tts-worker.js` |
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) | 3.7.5 (`transformers.web.js`) | Apache-2.0 | Model loading / tokenisation for Kokoro | `tts-worker.js` |
| [`@mozilla/readability`](https://github.com/mozilla/readability) | 0.6.0 | Apache-2.0 | Article extraction | `reader-inject.js` |
| [`@breezystack/lamejs`](https://github.com/gideonstele/lamejs) (JavaScript port of LAME) | 1.2.7 | **LGPL-3.0** | MP3 encoding for “Save as MP3” | `reader-inject.js`, and the shared reader chunk the PDF and queue pages load |
| [`pdf-lib`](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | Writing highlights and notes into PDF files | a chunk of the PDF page, loaded on first save |
| [pdf.js](https://github.com/mozilla/pdf.js) (legacy build) | as shipped in `pdfjs-dist` | Apache-2.0 | Rendering and text extraction for PDFs | `vendor/pdfjs/*` (loaded at runtime, with its own worker, CMaps and standard fonts) |
| [WXT](https://wxt.dev) | 0.21.4 | MIT | Build tooling only (not shipped) | — |

`onnxruntime-web` is intentionally **not** bundled into `tts-worker.js`; it is copied verbatim to
`vendor/ort/` and loaded by URL at runtime (`src/engine/ort-loader.ts`). Bundling it makes Vite
inline its ~33 MB of `.wasm` as base64.

## Voice / model files (downloaded at first use, never bundled)

### Piper — [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) @ `v1.0.0`

Model weights are Apache-2.0 (the Piper project). The catalogue in `public/models.json` lists
**171 voices** (four more in the upstream catalogue need phonemizers Aloud lacks, and are left out), and each one's `license` field currently reads "see MODEL_CARD (per-voice;
rhasspy/piper-voices)" rather than the dataset's actual licence — the table that used to stand
here named eight voices and read as though it were the whole list, which it never was.

Each voice's real dataset licence is in its own model card under
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) (`@ v1.0.0`), beside the
`.onnx` file Aloud downloads. Examples of the range: `en_US-ryan-high` and `en_US-amy-medium` are
CC-BY-4.0, `de_DE-thorsten-medium` is CC0-1.0, `en_GB-alan-medium` is Open Government Licence
v3.0, and `en_US-lessac-*` comes from Blizzard 2013 (research terms). Resolving all 171 into this
file, from the model cards at build time, is outstanding work — until then, treat the model card
as the authority for any voice you ship or redistribute.

### Kokoro — [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)

Model weights: **Apache-2.0**. Per-voice style vectors (`voices/*.bin`) are fetched by `kokoro-js`
and cached via the Cache API (`kokoro-voices`) — the one download that does not go through the
extension's IndexedDB store.

### Supertonic — [`Supertone/supertonic-2`](https://huggingface.co/Supertone/supertonic-2)

Model weights: **OpenRAIL-M**, a *use-restricted* licence — its behavioural conditions travel with
the weights, so anyone redistributing them (or a product built on them) must pass the conditions
on. Aloud never bundles the weights: they are downloaded from Hugging Face on first use, and the
licence is shown on the engine's card in Settings before that download.

## Source availability

This repository is the complete corresponding source. `npm ci && npm run build` reproduces
`.output/firefox-mv3/` (see `BUILD.md`). The only non-source binaries in the tree are the vendored
ONNX Runtime Web `.wasm`/`.mjs` files under `public/vendor/ort/`, copied unmodified from the
`onnxruntime-web` npm package by `scripts/sync-assets.mjs`.
