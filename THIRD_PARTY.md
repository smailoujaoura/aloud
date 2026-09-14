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
| [`@breezystack/lamejs`](https://github.com/breezystack/lamejs) (JavaScript port of LAME) | 1.2.7 | **LGPL-3.0** | MP3 encoding for “Save as MP3” | `reader-inject.js`, and the shared reader chunk the PDF and queue pages load |
| [WXT](https://wxt.dev) | 0.21.4 | MIT | Build tooling only (not shipped) | — |

`onnxruntime-web` is intentionally **not** bundled into `tts-worker.js`; it is copied verbatim to
`vendor/ort/` and loaded by URL at runtime (`src/engine/ort-loader.ts`). Bundling it makes Vite
inline its ~33 MB of `.wasm` as base64.

## Voice / model files (downloaded at first use, never bundled)

### Piper — [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) @ `v1.0.0`

Model weights are Apache-2.0 (the Piper project). Each *voice* carries its own dataset licence,
recorded per-entry in `public/models.json`:

| Voice | Dataset licence |
|---|---|
| `en_US-hfc_female-medium` | HiFi-CAPTAIN / CC0-style |
| `en_US-lessac-medium` | Blizzard 2013 (research/BSD-style) |
| `en_US-ryan-high` | CC-BY-4.0 |
| `en_US-amy-medium` | CC-BY-4.0 |
| `en_GB-alan-medium` | Open Government Licence v3.0 |
| `de_DE-thorsten-medium` | CC0-1.0 |
| `fr_FR-siwis-medium` | CC-BY-4.0 |
| `es_ES-sharvard-medium` | CC-BY-4.0 |

### Kokoro — [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)

Model weights: **Apache-2.0**. Per-voice style vectors (`voices/*.bin`) are fetched by `kokoro-js`
and cached via the Cache API (`kokoro-voices`) — the one download that does not go through the
extension's IndexedDB store.

## Source availability

This repository is the complete corresponding source. `pnpm install && pnpm build` reproduces
`.output/firefox-mv3/` (see `BUILD.md`). The only non-source binaries in the tree are the vendored
ONNX Runtime Web `.wasm`/`.mjs` files under `public/vendor/ort/`, copied unmodified from the
`onnxruntime-web` npm package by `scripts/sync-assets.mjs`.
