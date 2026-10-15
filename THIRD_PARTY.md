# Third-party components

Aloud is distributed under **GPL-3.0-or-later** (see `LICENSE`). The determining factor is
eSpeak-NG, which is GPLv3 and is bundled twice as the grapheme-to-phoneme engine: rhasspy's
eSpeak-NG fork inside `piper_phonemize` for Piper voices (every language) and Kokoro's Spanish,
French, Italian, Portuguese and Hindi voices, and the English-only build inside the `phonemizer`
package that kokoro-js uses for Kokoro's English voices.

## Bundled libraries

| Component | Version | License | How it is used | Where it ends up |
|---|---|---|---|---|
| [eSpeak-NG, rhasspy fork](https://github.com/rhasspy/espeak-ng) in [`piper-phonemize`](https://github.com/rhasspy/piper-phonemize), compiled to WASM | as shipped in [`@diffusionstudio/piper-wasm`](https://github.com/diffusion-studio/piper-wasm) 1.0.0 | **GPL-3.0-or-later** (eSpeak-NG); MIT (piper-phonemize, build wrapper) | Text → IPA phonemes for Piper, in every language eSpeak supports — the phonemiser Piper voices were trained with — and for Kokoro's non-English voices | `vendor/piper/piper_phonemize.{wasm,data}` (loaded at runtime), glue in `vendor/rt/piper-*.js` |
| [eSpeak-NG](https://github.com/espeak-ng/espeak-ng) (compiled to WASM, inlined in `phonemizer`) | as shipped in `phonemizer` 1.2.1 | **GPL-3.0-or-later** | Text → IPA phonemes for Kokoro's English voices (English data only) | `vendor/rt/kokoro-*.js` (base64-inlined WASM + data) |
| [`phonemizer`](https://github.com/xenova/phonemizer.js) | 1.2.1 | Apache-2.0 (wrapper) | eSpeak-NG JS wrapper used by kokoro-js | `vendor/rt/kokoro-*.js` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | 1.22.0 | MIT | Neural network inference (WASM, optionally WebGPU) | `vendor/ort/*` (loaded at runtime) |
| [`kokoro-js`](https://github.com/hexgrad/kokoro) | 1.2.1 | Apache-2.0 | Kokoro engine wrapper | `tts-worker.js` |
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) | 3.7.5 (`transformers.web.js`) | Apache-2.0 | Model loading / tokenisation for Kokoro | `tts-worker.js` |
| [`@mozilla/readability`](https://github.com/mozilla/readability) | 0.6.0 | Apache-2.0 | Article extraction | `reader-inject.js` |
| [`@breezystack/lamejs`](https://github.com/gideonstele/lamejs) (JavaScript port of LAME) | 1.2.7 | **LGPL-3.0** | MP3 encoding for “Save as MP3” | `reader-inject.js`, and the shared reader chunk the PDF and queue pages load |
| [Inter](https://rsms.me/inter/) via [`@fontsource-variable/inter`](https://fontsource.org/fonts/inter) | 5.3.0 | **OFL-1.1** | The interface typeface of Aloud's own pages (Latin subsets) | `fonts/` |
| Preview sentences: one sentence each from the Wikipedia articles on the rainbow, as [Piper](https://github.com/rhasspy/piper) collects them for its samples | — | **CC BY-SA 4.0** (Wikipedia) | What a voice says when previewed, in 39 languages | `src/ui/preview-sentences.ts` |
| [flag-icons](https://github.com/lipis/flag-icons) | 7.5.0 | MIT | The small flag beside each language on the Voice page (47 of its SVGs, copied in) | `flags/` |
| [`pdf-lib`](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | Writing highlights and notes into PDF files | a chunk of the PDF page, loaded on first save |
| [pdf.js](https://github.com/mozilla/pdf.js) (legacy build) | 6.3.289 (`pdfjs-dist`) | Apache-2.0 | Rendering and text extraction for PDFs | `vendor/pdfjs/*` (loaded at runtime, with its own worker, CMaps and standard fonts) |
| Voice portraits: generated images of people who do not exist, made for Aloud with [SDXL](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) and the [SDXL-Lightning](https://huggingface.co/ByteDance/SDXL-Lightning) UNet | — | Made for Aloud; the models are under CreativeML OpenRAIL++-M | A face beside each Kokoro voice and a few Piper ones; Settings says each is generated | `portraits/` |
| [WXT](https://wxt.dev) | 0.21.4 | MIT | Build tooling only (not shipped) | — |

`onnxruntime-web` is intentionally **not** bundled into `tts-worker.js`; it is copied verbatim to
`vendor/ort/` and loaded by URL at runtime (`src/engine/ort-loader.ts`). Bundling it makes Vite
inline its ~33 MB of `.wasm` as base64.

## Voice / model files (downloaded at first use, never bundled)

### Piper — [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices) @ `39ab474`

The Piper software is MIT; each voice's licence is that of the recordings it was trained on, and
they differ. **[`PIPER_VOICE_LICENCES.md`](PIPER_VOICE_LICENCES.md) lists all 171 voices** in
`public/models.json` (four more in the upstream catalogue need phonemizers Aloud lacks, and are
left out) with each one's dataset and licence, copied from its own model card by
`scripts/piper-licences.mjs`.

In short: most are public domain (CC0) or ask for attribution (CC BY); some are share-alike;
17 are for **non-commercial use only** (CC BY-NC, CC BY-NC-SA); the three Lessac voices come from
the Blizzard 2013 research licence — and most English voices, and many in other languages, are
fine-tuned from Lessac, so its terms reach them too. For about a fifth of the voices the card says
only "See URL" or nothing; the dataset's own page is then the authority.

Aloud never bundles a voice: it is downloaded from Hugging Face when you choose it, for you to
use. Anyone redistributing a voice, or using it in a product, should check its model card.

### Kokoro — [`onnx-community/Kokoro-82M-v1.0-ONNX`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)

Model weights and voices: **Apache-2.0**. One download holds the model (the quantised build on a
CPU, the full-precision one with a graphics card) and all 41 voices' style files (`voices/*.bin`).
Everything comes from the same pinned commit, and every voice file is checked against its
published SHA-256 (`src/shared/kokoro-voice-pins.ts`) before it is kept. The model goes to the
extension's IndexedDB store, the voices to Cache Storage (`kokoro-voices`), where `kokoro-js`
reads them.

### Supertonic — [`Supertone/supertonic-2`](https://huggingface.co/Supertone/supertonic-2)

Model weights: **OpenRAIL-M**, a *use-restricted* licence — its behavioural conditions travel with
the weights, so anyone redistributing them (or a product built on them) must pass the conditions
on. Aloud never bundles the weights: they are downloaded from Hugging Face on first use, and the
licence is shown on the engine's card in Settings before that download.

## Source availability

This repository is the complete corresponding source. `npm ci && npm run build` reproduces
`.output/chrome-mv3/` and `.output/firefox-mv3/` (see `BUILD.md`). The third-party runtime files
under `public/vendor/` (ONNX Runtime Web, pdf.js, piper_phonemize) are not kept in the
repository: `scripts/sync-assets.mjs` copies them, unmodified, from the npm packages above at
build time. The binary files in the tree are the Inter fonts (`public/fonts/`, OFL-1.1, from
`@fontsource-variable/inter`), Aloud's icons (`public/icon/`, drawn for Aloud, with their SVG
source beside them) and the generated voice portraits (`public/portraits/`).

The packaged extension carries its licence and every bundled component's notice in `licenses/`,
written at build time by `scripts/notices.mjs`.
