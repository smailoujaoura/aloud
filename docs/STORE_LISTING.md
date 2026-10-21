# Store submission: what to paste where

Everything below matches Aloud 1.0.0 as built (`npm run zip`). If the manifest's permissions
change, change the justifications here too: both stores compare them.

## Shared listing text

**Name:** Aloud — Offline Neural Reader

**Summary (Chrome: 132 characters max; this is the manifest description, 129):**
Reads any article or PDF aloud in a natural neural voice that runs on your device. Offline and private, it highlights every word.

**Description** (for Chrome, drop "Works on Firefox for Android too."):

> Listen to the web in a natural voice that lives on your device.
>
> Aloud reads any article or PDF aloud and lights up each sentence, and with most voices each
> word, as it's read. The voice is a neural network running inside your browser, so it works
> offline and nothing you read is ever sent anywhere. No account, no subscription, free and open
> source.
>
> • 222 natural voices in 52 languages, from three neural engines: Supertonic 3, Kokoro-82M and Piper
> • Reads the article, not the menus and ads, and highlights the sentence and the word in place
> • A page in two languages? Each passage is read by a voice that speaks it
> • PDFs too: real pages, highlighted where the text sits; mark them up and save the marks into the file
> • Picks up at the sentence you stopped at; a reading queue for later; save any article as an MP3
> • Highlights, notes and tags on any website, kept on your device and exportable as Markdown
> • The same keys for reading and for any video or audio on the web: S slower, D faster, R normal speed, Z back, X forward. It can also stop videos that play by themselves
> • Every key can be changed. Light and dark themes. Works on Firefox for Android too.
>
> Private by construction: there is no Aloud server. Voices download once from Hugging Face; after
> that, reading needs no connection at all.
>
> Bugs and ideas: https://aloud.souj.dev/feedback.html
> Source code: https://github.com/smailoujaoura/aloud

**Category:** Chrome: Productivity → Tools (or Accessibility). Firefox: Language & Accessibility / Other.

**Website:** https://aloud.souj.dev — **Privacy policy:** https://aloud.souj.dev/privacy.html

**Support:** https://aloud.souj.dev/feedback.html (bugs go to GitHub issues from there)

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
| unlimitedStorage | Voice models are 21–402 MB each and are cached locally so reading works offline. |
| contextMenus | Right-click items: read the selection or from a point, keep a highlight, show notes, add a page or link to the reading queue. |
| Host: file:///* | Lets the PDF reader open PDFs saved on the user's computer, once they enable "Allow access to file URLs". |
| Optional host: *://*/* | Requested one site at a time, only when the user adds a site where the media controls or highlights should start by themselves, opens a PDF from that site, or queues a page from it. |

**Remote code:** No. All JavaScript and WebAssembly ship in the package, including ONNX
Runtime's, which transformers.js would otherwise take from cdn.jsdelivr.net (Aloud sets the local
path before it loads). In the Chrome package that unused CDN line is removed from the bundled
transformers.js; the Firefox package keeps the library exactly as published, as Mozilla requires.
Voice models downloaded at runtime are ONNX data files, not code.

**Data usage:** disclose what Aloud *handles*, even though it all stays on the device. Chrome's User
Data FAQ (question 3): "Extensions are required to disclose how they handle user data, even when
data is processed or stored locally" — "handle" includes using information about the websites a
user reads. So tick, with the explanation below, the dashboard's categories for:

- **Website content** — the text of pages and PDFs being read; articles saved to the reading queue;
  the passages kept as notes and highlights.
- **Web history** (web browsing activity) — the addresses of pages read, with where reading stopped
  (history, reading positions) and the sites in the listening statistics.

Explanation to give: *"Used only on the user's device, to read pages aloud and to keep the user's
own history, reading positions, notes and statistics. Stored in the browser's extension storage on
the device; never transmitted, sold or shared. Aloud has no server."* Check the dashboard's current
category names and definitions when filling it in. Certify all three statements (no sale, no
unrelated use, no creditworthiness use).

Open question: the same FAQ (question 9) asks that user data be "stored at rest using a strong
encryption method such as RSA or AES", without saying whether that covers data kept on the user's
own device. Aloud's local storage is not encrypted (as with browser storage generally). If a
reviewer raises it, the answer is that nothing leaves the device and the browser profile is the
user's own; encrypting it would need a key stored beside it.

Publish the current privacy policy (website/privacy.html, 17 October) before submitting: the live
page was still the 4 October version, without the Limited Use statement.

**Private / incognito windows:** the manifest declares `"incognito": "not_allowed"`. Aloud keeps
reading positions, history and listening statistics, and private-window activity must not be stored
(Mozilla add-on policy 6.3), so it does not run in private windows at all. The privacy policy says so.

## Firefox Add-ons (AMO)

- **Data collection:** the manifest declares `data_collection_permissions: { required: ["none"] }`.
- **Source code:** upload `.output/tts-reader-1.0.0-sources.zip` with this note for the reviewer:

  > Built with Node 22.23 and npm 10.9 on Linux: `npm ci && npm run build:firefox` (the archive's
  > `.npmrc` sets legacy-peer-deps, which the lockfile needs). The build needs no network after
  > `npm ci`: the voice catalogue (`public/models.json`) is committed, and refreshing it is a
  > separate maintainer step. Output is `.output/firefox-mv3/`, byte-identical to the uploaded
  > package — checked by unpacking this archive into another folder, installing from the same
  > lockfile, building and comparing all 347 files' SHA-256. The code is not minified and file
  > names carry no hashes, so versions can be compared file by file.
  > Vendored, unmodified third-party files (ONNX Runtime Web, pdf.js, piper-phonemize WASM) are
  > copied from node_modules by `scripts/sync-assets.mjs`; versions are listed in THIRD_PARTY.md.
  > Validator warnings: the `Function`-constructor ones come from those libraries, and cannot run:
  > the extension CSP is `script-src 'self' 'wasm-unsafe-eval'`, with no `'unsafe-eval'`, and
  > pdf.js is also given `isEvalSupported: false`. The four `innerHTML` warnings
  > (`reader-inject.js`, `chunks/session.js`) are inside Mozilla Readability 0.6.0, bundled into
  > both; Aloud runs it on `document.cloneNode(true)` (`src/extract/readability.ts`), an inert
  > copy of the page. The `import()` warnings (`vendor/rt/ort-loader.js`, `chunks/pdf.js`, and
  > inside the libraries) load files from the package itself (`vendor/ort/`, `vendor/pdfjs/`) by
  > their `runtime.getURL` address, never a remote or user-supplied one. Nothing is loaded from a
  > CDN: ONNX Runtime's WebAssembly path is set to `vendor/ort/` before transformers.js loads
  > (`src/engine/ort-loader.ts`, `src/engine/engines/kokoro.ts`). transformers.js 3.7.5 is bundled
  > unmodified from npm (`vendor/rt/transformers.web.js`); its default
  > `wasmPaths = https://cdn.jsdelivr.net/...` (line ~2901 of `dist/transformers.web.js`) runs only
  > when no path is set, which never happens here, and the extension CSP would block it anyway.
  > What is downloaded at run time is voice data from Hugging Face (ONNX weights, JSON, `.bin`
  > style vectors), never code. Aloud does not run in private windows (`incognito: not_allowed`).
  > On uninstall it opens aloud.souj.dev/feedback.html?bye; the version and browser name follow a
  > `#`, which the browser never sends, so opening it transmits nothing.
  > To try it: open any article, press the toolbar button (or Alt+R), then play. The first voice
  > (about 60 MB) downloads on first use.

- **Android:** the listing is marked compatible with Firefox for Android (`gecko_android`).
  Piper voices are the ones to recommend on phones; Supertonic 3 works there, slower than speech on
  older phones; Kokoro is too heavy for them.

## Before pressing submit

- [ ] `data-stores="live"` on `website/index.html` `<body>`, and the three store URLs checked
- [ ] The Piper voice licences reviewed (PIPER_VOICE_LICENCES.md; regenerate with `node scripts/piper-licences.mjs` if the catalogue changed)
- [ ] Screenshots: Chrome needs 1280×800 or 640×400; a 440×280 promo tile is optional but recommended
