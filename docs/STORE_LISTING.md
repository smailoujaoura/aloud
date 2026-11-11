# Store submission: what to paste where

Everything below matches Aloud 1.0.3 as built (`npm run zip`). If the manifest's permissions
change, change the justifications here too: both stores compare them.

## Shared listing text

**Name:** Aloud: Natural Text to Speech Reader, Offline (45 characters; AMO allows 50, Chrome 75). Before:
"Aloud: Natural Text to Speech, Offline" in 1.0.1 and 1.0.2, "Aloud — Offline Neural Reader" until
1.0.1. Chrome takes the name from the manifest. On AMO the listing's name, summary and description
are edited in the Developer Hub (Edit Product Page): uploading a version does not change them.
The AMO address is `aloud-natural-text-to-speech` since 1.0.1. Do not change it again: AMO does
not redirect an old address (`aloud-offline-neural-reader` shows "Oops" now), so every link to it
breaks. A link that must survive a rename can use the add-on's ID: `/firefox/addon/aloud@souj.dev/`.

**Summary (Chrome: 132 characters max; this is the manifest description, 129):**
Reads any article or PDF aloud in a natural neural voice that runs on your device. Offline and private, it highlights every word.

**Description** (for Chrome, drop "(on a phone, a speed button on the video)" and "Works on Firefox for Android too.": Chrome has no add-ons on phones):

> Listen to the web in a natural voice that lives on your device.
>
> Aloud reads any article or PDF aloud and lights up each sentence, and with most voices each
> word, as it's read. The voice is a neural network running inside your browser, so it works
> offline and nothing you read is sent anywhere, unless you choose to use a speech server of your
> own. No account, no subscription, free and open source.
>
> • 324 natural voices in 52 languages, from four neural engines: Phonon, Supertonic 3, Kokoro-82M and Piper
> • Reads the article, not the menus and ads, and highlights the sentence and the word in place; documentation too, with its notes, tips and code
> • A page in two languages? Each passage is read by a voice that speaks it
> • Reads pages that show their text in an embedded page (Claude artifacts) or inside web components (MSN)
> • The whole page, a selection, or from any sentence: with a click, a right-click or a key
> • PDFs too: real pages, highlighted where the text sits; mark them up, kept on your device, and save the marks into the file
> • Picks up at the sentence you stopped at; a reading queue for later; save any article as an MP3
> • Highlights, notes and tags on any website, kept on your device and exportable as Markdown
> • The same keys for reading and for any video or audio on the web: S slower, D faster, R normal speed, Z back, X forward, M mute (on a phone, a speed button on the video). Alt+M turns the video control on or off for a site, and it can stop videos that play by themselves
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

## Release notes for 1.0.3 (AMO's version notes; plain text)

> Fixed
> • A voice no longer stops with "… is not producing audio" over a moment's trouble: a sentence that fails is asked for again, and the reader starts again by itself before saying so.
> • N keeps the sentence being read, the one highlighted, and says which; it could keep the sentence before it.
> • Notes, tips and warnings in documentation are read (the Swift book's were all skipped), and so are one-line code listings, passages Readability left out between paragraphs (MDN's opening section) and an article's standfirst.
> • Read selection no longer loses your place in the page: when it ends, the reader goes back to where you were.
> • Back a little (Z) goes back one sentence at a time, as X goes forward one, instead of two or three short ones at once.
> • Read from here is in the right-click menu again, also on selected text, on links and in embedded pages.
> • PDFs: N highlights the sentence on the page; zooming no longer moves the highlight off the words; closing the reading bar and pressing Aloud again reads in the same tab; highlights say "Kept on this device", as they are.
> • The video speed keys are left to the page when it has no video or audio to control.
> • On a phone asking for desktop sites, the speed button shows on videos, YouTube Shorts included.
>
> New
> • Keys for Read selection (Alt+L) and Read from here (Alt+G): from the selection, or from where you last clicked. In Chrome, choose them in chrome://extensions/shortcuts.
> • Video speed: "But never on", a list of sites where the speed control never starts by itself.
>
> Changed
> • A new name: Aloud: Natural Text to Speech Reader, Offline.
> • Alt+M turns the video speed control on and off for the site, and says which.
> • pdf.js is included as Mozilla publishes it unminified, for the Chrome Web Store's code readability rules.

## Release notes for 1.0.2 (AMO's version notes; plain text)

> New
> • Pages that show their text in an embedded page from another site, such as Claude's artifacts, are read: Aloud offers to read the embedded page and asks once for that site.
> • Pages built from web components, such as MSN's articles, are read, with their highlights. When "Continue reading" reveals the rest of an article, the rest is read too.
> • Read selection, Read from here and notes work inside embedded pages, and the Library opens those notes there.
>
> Fixed
> • On long articles the reading bar stays one row, with a shorter time left that no longer shifts the buttons.
> • A voice of your own speech server chosen for a language shows on the voice board.
> • A voice of your own speech server reads the languages chosen for it beside a voice in the browser, instead of failing to load.

## Release notes for 1.0.1 (AMO's version notes; plain text)

> New
> • Phonon voices by Gradium: natural voices that read about twice as fast as real time on any processor. 102 voices in English, French, Spanish, German and Portuguese, each with a face, in one 101 MB download. The default voice. Licensed for non-commercial use.
> • Your own speech server: read with Kokoro-FastAPI or any OpenAI-style speech server you run, at home, over Tailscale, or over the internet with a key.
> • Video speed on phones: a speed button on the video, in full screen too.
> • M mutes and unmutes the video you're watching, like the speed keys.
>
> Fixed
> • Text in a script none of your voices can read is skipped, with a Get one button, instead of being read as noise.
> • Chinese, Japanese and Thai are highlighted word by word; kanji-only headings on Japanese pages are read in Japanese.
> • Short phrases in another language are recognised far more often.
> • Read from here starts at the sentence you right-clicked.
> • The bar no longer jumps to two rows at sentence 10, and the video speed shows in full screen.
> • On phones the reading bar is two rows instead of three, with the progress beside the play controls.
> • PDFs: rotated pages are read, two PDFs with the same name keep separate places, and the newest file chosen wins.
> • Sites that show each article at its own #/ address keep a place and notes per article.
> • A download that does not fit no longer damages the voices you have.
>
> Changed
> • A new name: Aloud: Natural Text to Speech, Offline.
> • Pronunciation fixes can be limited to one language.
> • Shorter engine tabs in Settings, which fit a phone.

The full list is CHANGELOG.md; the Chrome Web Store has no release notes field.

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
| identity | Signs the user in to their own Dropbox when they connect it in Settings (launchWebAuthFlow, OAuth with PKCE), for the optional sync of their notes. No Google account access, no other use. (1.0.4) |
| alarms | While the user's Dropbox is connected, checks it every 15 minutes for notes written on their other devices. (1.0.4) |
| Host: file:///* | Lets the PDF reader open PDFs saved on the user's computer, once they enable "Allow access to file URLs". |
| Optional host: *://*/* | Requested one site at a time, only when the user adds a site where the media controls or highlights should start by themselves, opens a PDF from that site, or queues a page from it. |

**Notes sync through the user's Dropbox (1.0.4):** off until the user connects their own Dropbox in
Settings, Sync & backup. Their notes and PDF highlights then go to one file in the app's folder of
their Dropbox (App folder access: Apps/Aloud-tts only), never to the developer. Dropbox's API
answers extension origins with CORS headers, so no dropbox.com host permission. New required
permissions `identity` and `alarms`, neither with an install warning. Firefox asks for the
optional `websiteContent` and `browsingActivity` data permissions on Connect (notes are passages
of pages with their addresses), and each sync checks them again. Chrome's data form: tick **Web
history** as well as Website content (a note keeps its page's address and title), used for the
single purpose, not sold, not used for anything else. Reviewer note line: "Optional: the reader can
connect their own Dropbox; their notes are then kept in one file in Aloud's app folder there, and
sent nowhere else."

**Remote code:** No. All JavaScript and WebAssembly ship in the package, including ONNX
Runtime's, which transformers.js would otherwise take from cdn.jsdelivr.net (Aloud sets the local
path before it loads). In the Chrome package that unused CDN line is removed from the bundled
transformers.js; the Firefox package keeps the library exactly as published, as Mozilla requires.
Voice models downloaded at runtime are ONNX data files, not code.

**Your own speech server (1.0.1, issue #9):** off by default. When a reader sets one up, each
sentence's text goes to the address they entered (their own Kokoro-FastAPI or similar), never to
the developer. It needs no new required permission: the host is asked for from the existing
optional `*://*/*`, one site at a time, from the reader's click; Firefox also asks for the optional
`websiteContent` data permission (`data_collection_permissions.optional`). Chrome's data form
already declares Website content; the privacy policy describes the server. Reviewer note line:
"Optional: the reader can point Aloud at their own OpenAI-style speech server; page text is then
sent only to the address they enter, after a permission prompt."

**Data usage:** disclose what Aloud *handles*, even though it all stays on the device. Chrome's User
Data FAQ (question 3): "Extensions are required to disclose how they handle user data, even when
data is processed or stored locally" — "handle" includes using information about the websites a
user reads. So tick, with the explanation below, the dashboard's categories for:

- **Website content** — the text of pages and PDFs being read; articles saved to the reading queue;
  the passages kept as notes and highlights.
- **Web history** (web browsing activity) — the addresses of pages read, with where reading stopped
  (history, reading positions) and the sites in the listening statistics.

Explanation to give: *"Used on the user's device, to read pages aloud and to keep the user's own
history, reading positions, notes and statistics, stored in the browser's extension storage on the
device. Never sold or shared, and Aloud has no server: the text being read leaves the device only if
the user sets up a speech server of their own, and then only to the address they enter, after a
permission prompt."* Check the dashboard's current
category names and definitions when filling it in. Certify all three statements (no sale, no
unrelated use, no creditworthiness use).

Open question: the same FAQ (question 9) asks that user data be "stored at rest using a strong
encryption method such as RSA or AES", without saying whether that covers data kept on the user's
own device. Aloud's local storage is not encrypted (as with browser storage generally). If a
reviewer raises it, the answer is that nothing leaves the device and the browser profile is the
user's own; encrypting it would need a key stored beside it.

Publish the current privacy policy (website/privacy.html, in effect from 4 November 2026) before
submitting 1.0.1: it describes the reader's own speech server and its permission, and the live page
was still the 17 October version.

**Private / incognito windows:** the manifest declares `"incognito": "not_allowed"`. Aloud keeps
reading positions, history and listening statistics, and private-window activity must not be stored
(Mozilla add-on policy 6.3), so it does not run in private windows at all. The privacy policy says so.

## Chrome Web Store: "obfuscated code" warning (10 November 2026)

Warning "Red Titanium" (Code Readability Requirements), 30 days to fix, on the published item
`ilnojbdjpnnlkjbmldpgbgckkkifheeo`. It quoted `vendor/pdfjs/pdf.min.mjs` and
`vendor/pdfjs/pdf.worker.min.mjs`: core-js's `Object.create` fallback, which pdf.js's legacy build
carries, and which builds `"java" + "script:"` for an iframe. Minified, it read as hidden code.

Fixed by shipping pdf.js's own unminified files (`pdf.mjs`, `pdf.worker.mjs`, same package and
version, `scripts/sync-assets.mjs`); nothing of ours or of pdf.js was changed. The modern pdf.js
build has no core-js, but needs `Map.prototype.getOrInsertComputed`, `Math.sumPrecise` and others
that Chrome 120 lacks. Submit the next version as a new draft; nothing else in the package was
quoted. If asked: the code is https://github.com/zloirock/core-js (`internals/object-create.js`),
bundled by https://github.com/mozilla/pdf.js in `pdfjs-dist/legacy/build/`.

## Firefox Add-ons (AMO)

- **Data collection:** the manifest declares `data_collection_permissions: { required: ["none"], optional: ["websiteContent"] }`:
  the optional one is asked for only when a reader sets up their own speech server (see above).
- **Source code:** upload `.output/tts-reader-1.0.3-sources.zip` with this note for the reviewer
  (AMO's field takes at most 3,000 characters; keep it under 2,900):

  > Build: Node 22.23, npm 10.9, Linux: npm ci && npm run build:firefox (the archive's .npmrc sets legacy-peer-deps, which the lockfile needs). No network is needed after npm ci: the voice catalogue (public/models.json) is committed. Output: .output/firefox-mv3/, byte-identical to the uploaded package (checked by building the source archive in a clean folder and comparing all 468 files' SHA-256). Nothing is minified.
  >
  > Vendored, unmodified npm files (ONNX Runtime Web, pdf.js, piper-phonemize WASM, and phonon-tts 0.4.2, Gradium's Phonon runtime, its WASM built from https://github.com/gradium-ai/xn-ptts) are copied from node_modules by scripts/sync-assets.mjs and pinned by the lockfile; versions in THIRD_PARTY.md. phonon-tts gets its model as local blob: URLs of files Aloud downloaded and checked itself, so its own Hugging Face lookup (hub.js) never runs.
  >
  > Validator warnings: the Function-constructor ones are inside those libraries and cannot run (CSP script-src 'self' 'wasm-unsafe-eval', no 'unsafe-eval'; pdf.js gets isEvalSupported: false). The innerHTML ones are Mozilla Readability 0.6.0, run on document.cloneNode(true), an inert copy of the page. The import() ones load files from the package itself by runtime.getURL. The document.write ones are core-js's Object.create fallback in pdf.js's legacy build, for engines without Object.create. Nothing loads from a CDN: ONNX Runtime's WASM path is set to vendor/ort/ before transformers.js loads.
  >
  > Downloaded at run time: voice data from Hugging Face (ONNX and GGUF weights, JSON, voice vectors), never code. Phonon's model (CC BY-NC 4.0) is an unmodified, ungated copy of Gradium's gated repository (smailoujaoura/phonon-40m-multilingual), checked by SHA-256.
  >
  > Optional, off by default: a speech server the reader runs (Settings > Voice > Custom). Page text then goes only to the address they enter, after a permission prompt for that host (optional *://*/*) and Firefox's optional websiteContent consent; both are checked again before every read, and nothing is sent if either was taken back.
  >
  > No private windows (incognito: not_allowed). On uninstall it opens aloud.souj.dev/feedback.html?bye; the version and browser follow a #, so nothing is transmitted.
  >
  > frame-ask.html, the second web-accessible page: the "Read it" button on a page whose article is in a frame from another site (a Claude artifact). Only a click in an extension page may call permissions.request, so the button is one; in Firefox, which gives an extension page inside a website no permissions API, it opens itself in a tab of its own, which asks. It requests only the site named by a one-time ticket the background issued for that tab (storage.session), so a site embedding it can make it ask for nothing.
  >
  > To try it: open an article, press the toolbar button (or Alt+R), then play. Phonon (about 101 MB with its voices) downloads on first use.

- **Android:** the listing is marked compatible with Firefox for Android (`gecko_android`).
  Phonon is the default there too (one worker); Piper voices are the smallest and quickest for older
  phones; Supertonic 3 works, slower than speech on older phones; Kokoro is too heavy for them.

## Before pressing submit

- [ ] The privacy policy deployed (website/privacy.html, in effect from 6 November 2026, for 1.0.2
      and 1.0.3: nothing new in 1.0.3 is collected or sent anywhere)

- [ ] `data-stores="live"` on `website/index.html` `<body>`, and the three store URLs checked
- [ ] The Piper voice licences reviewed (PIPER_VOICE_LICENCES.md; regenerate with `node scripts/piper-licences.mjs` if the catalogue changed)
- [ ] Screenshots: Chrome needs 1280×800 or 640×400; a 440×280 promo tile is optional but recommended
