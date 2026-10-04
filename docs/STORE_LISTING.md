# Store submission: what to paste where

Everything below matches Aloud 1.0.0 as built (`npm run zip`). If the manifest's permissions
change, change the justifications here too: both stores compare them.

## Shared listing text

**Name:** Aloud — Offline Neural Reader

**Summary (Chrome: 132 characters max; this is the manifest description, 129):**
Reads any article or PDF aloud in a natural neural voice that runs on your device. Offline and private, it highlights every word.

**Description:**

> Listen to the web in a natural voice that lives on your device.
>
> Aloud turns any article or PDF into natural speech and lights up every word as it is read. The
> voice is a neural network running inside your browser, so it works offline and nothing you read
> is ever sent anywhere. No account, no subscription.
>
> • 213 natural voices in 51 languages, from three neural engines (Piper, Kokoro-82M, Supertonic-2)
> • Reads the article, not the menus and ads, and highlights the sentence and the word in place
> • PDFs too: real pages, highlighted where the text sits; mark them up and save the marks into the file
> • Picks up at the sentence you stopped at; a reading queue for later; save any article as an MP3
> • Highlights and notes kept on your device, exportable as Markdown, in one backup file
> • Listening controls for any video or audio on the web: speed, rewind and skip, and stopping videos that play by themselves
> • Every key can be changed. Light and dark themes.
>
> Private by construction: there is no Aloud server. Voices download once from Hugging Face; after
> that, reading needs no connection at all.

**Category:** Chrome: Productivity → Tools (or Accessibility). Firefox: Language & Accessibility / Other.

**Website:** https://aloud.souj.dev — **Privacy policy:** https://aloud.souj.dev/privacy.html

**Support:** https://souj.dev/contact

## Chrome Web Store — Privacy practices tab

**Single purpose:**

> Aloud helps people listen to web content on their own device: it reads articles and PDFs aloud
> with a local neural voice, and gives the same listening controls (speed, rewind, skip, stopping
> unwanted autoplay) to any video or audio playing on a page. Highlights and notes support
> following and returning to what was heard.

Why this is one purpose, if a reviewer asks: every feature is about *listening to what is on the
page*. The media controls apply the same speed keys the reader uses to the page's own players;
notes and highlights mark passages while listening. Nothing is unrelated to listening (no
search, shopping, new-tab or ad features).

**Permission justifications:**

| Permission | Justification |
|---|---|
| activeTab | Runs the reader, highlighter or media controls only on the tab where the user starts Aloud (toolbar button, shortcut or context menu). No access to other tabs. |
| scripting | Injects the reader and highlighter into that tab when the user starts them, instead of running content scripts on every site. |
| storage | Keeps settings, notes, reading queue, history and reading positions locally. |
| unlimitedStorage | Voice models are 21–262 MB each and are cached locally so reading works offline. |
| contextMenus | Right-click items: read the selection or from a point, keep a highlight, show notes, add a page or link to the reading queue. |
| Host: huggingface.co and its download hosts (hf.co, cdn-lfs*.huggingface.co) | Downloading the voice model the user picks. No other data is sent. |
| Host: file:///* | Lets the PDF reader open PDFs saved on the user's computer, once they enable "Allow access to file URLs". |
| Optional host: *://*/* | Requested one site at a time, only when the user adds a site where the media controls or highlights should start by themselves, or queues a page from that site. |

**Remote code:** No. All JavaScript and WebAssembly ship in the package. Voice models
downloaded at runtime are ONNX data files, not code.

**Data usage:** tick nothing. Aloud does not collect or transmit any of the listed data types.
Certify all three statements (no sale, no unrelated use, no creditworthiness use).

## Firefox Add-ons (AMO)

- **Data collection:** the manifest declares `data_collection_permissions: { required: ["none"] }`.
- **Source code:** upload `.output/tts-reader-1.0.0-sources.zip` with this note for the reviewer:

  > Built with Node 22.12+ and npm on Linux: `npm ci && npm run build:firefox`. Output is
  > `.output/firefox-mv3/`, byte-identical to the uploaded package (verified from a clean copy).
  > Vendored, unmodified third-party files (ONNX Runtime Web, pdf.js, piper-phonemize WASM) are
  > copied from node_modules by `scripts/sync-assets.mjs`; versions are listed in THIRD_PARTY.md.
  > The `Function`-constructor lint warnings come from those libraries.

- **Android:** the listing is marked compatible with Firefox for Android (`gecko_android`).
  Kokoro and Supertonic are too heavy for phones; Piper voices are the ones to recommend there.

## Before pressing submit

- [ ] `data-stores="live"` on `website/index.html` `<body>`, and the three store URLs checked
- [ ] The Piper voice licences reviewed (THIRD_PARTY.md)
- [ ] Screenshots: Chrome needs 1280×800 or 640×400; a 440×280 promo tile is optional but recommended
