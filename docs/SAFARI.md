# Aloud for Safari (Mac, iPhone and iPad)

The Safari build is the same extension with fewer engines, wrapped in a small native app that Xcode
builds: Safari extensions ship through the App Store, for Mac and iPhone alike.

## Where it stands (1.0.5)

Checked from a terminal, on a Mac with Xcode 27.2:

- `npm run build:safari` makes `.output/safari-mv3`, and both apps build from it:
  `xcodebuild -project safari/Aloud/Aloud.xcodeproj -scheme "Aloud (macOS)"` and
  `-scheme "Aloud (iOS)" -sdk iphonesimulator` succeed, with the extension packed inside.
- The speech engine speaks in WebKit: `npm run test:engine:webkit` loads Phonon in the built worker
  and makes three sentences (about 3 times as fast as speech on one worker, on an M-series Mac);
  `node scripts/engine-check.mjs webkit .output/safari-mv3 supertonic F1@en` does the same for
  Supertonic (about 1.2 times, on the processor).
- The background runs as one classic file (see below); the Chrome package built the same way
  passes the 23 release checks (`npm run test:e2e:chromium`).

**Not checked: anything inside Safari itself.** Turning an extension on is a click in Safari's
settings that no script can make, so the extension has not yet run in Safari on a Mac or a phone.
"What to test first" below is the list, most likely trouble first.

## What is in it, and why

- **Phonon, Supertonic and the reader's own server.** No Piper and no Kokoro: both read through
  eSpeak-NG (GPL-3.0), and the App Store's terms do not allow GPL code. Nothing of eSpeak goes into
  the Safari package:
  - The worker is built with `__ALOUD_ESPEAK__` false (scripts/build-worker.mjs), so Piper's and
    Kokoro's imports are dropped from engine/worker-main.ts and their chunks are never emitted.
  - `vendor/piper/` is left out of the package (wxt.config.ts, `build:publicAssets`).
  - shared/engine-catalog.ts offers only the three engines.
  - Its notices are its own (scripts/notices.mjs writes `.gen/licenses-safari/`, which wxt.config.ts
    packs in place of the others'): they name neither eSpeak-NG nor the packages only Piper and
    Kokoro need. The walkthrough's two lines that named them say what this edition has instead.

  Check after any change: `grep -rIl -i "piper_phonemize" .output/safari-mv3` finds nothing, and
  `.output/safari-mv3/vendor/rt/` holds worker-main.js, model-cache.js, time-stretch.js, phonon.js,
  server.js and supertonic.js, and nothing of Piper or Kokoro.
- **The worker's own file is imported by nothing** (src/worker/entry.ts). WebKit runs a module
  worker's entry file a second time when another module imports it, and the second copy took the
  worker over with no voice loaded: every sentence failed with "engine not initialised". The entry
  now loads the worker proper by its address, and the build stops if any file imports the entry.
- **The background is one classic file** in Safari (`type` in entrypoints/background.ts is set for
  Firefox and Chromium only): whether Safari loads a module as an extension's service worker
  depends on its version, and Apple's converter says it does not support `background.type`.
- **Safari is its own browser in the code** (shared/browser-env.ts: `webkit`), and an iPhone or
  iPad is a phone (`touchFirst`): one voice loaded at a time, one synthesis worker, the speed button
  on videos, no Shortcuts page. An iPad that calls itself a Mac is told by its touch screen.
- **No `identity` permission.** Safari has no identity API, so Dropbox sign-in uses the code Dropbox
  shows, as on Firefox for Android (options/dropbox-panel.ts already does this when
  `browser.identity` is missing).
- **Safari 17 and later** (`vite.build.target`, and iOS 17 in the Xcode project). The CSS Custom
  Highlight API arrived in 17.2; on 17.0 and 17.1 the sentence is marked by wrapping it in a span
  (highlight/highlighter.ts), and words are not marked.
- **Aloud's own code is GPL-3.0.** Before an App Store submission, its author adds an App Store
  exception to Aloud's own licence: `licenses/LICENSE.txt` in the package is that licence as it
  stands in the repository. The third-party code left in the package (ONNX Runtime, pdf.js,
  Readability, phonon-tts, lamejs and others) is MIT, Apache-2.0 or LGPL.

## Build on the Mac

Node 22 and npm (as BUILD.md), then from the repository:

```bash
npm ci
npm run build:safari        # .output/safari-mv3, and the Xcode project's version set from package.json
```

The Xcode project is in `safari/Aloud/` and is committed (Xcode's per-user files are ignored). It
packs the build by paths relative to itself (`../../../.output/safari-mv3/…`), one for each
top-level file and folder of the build. `npm run build:safari` ends by checking that list
(scripts/safari-project.mjs): a file the build has gained must be added to the project's "Shared
(Extension)/Resources" group, and one it has lost removed, or the script says which and fails.

After a change to the extension: `npm run build:safari`, then Run in Xcode.

The app's icons are drawn from `public/icon/icon.svg` by `node scripts/safari-icons.mjs` (Apple's
converter enlarges the 128-pixel PNG instead, a blur at the App Store's 1024). Run it again when
the icon changes.

Made the first time with:

```bash
xcrun safari-web-extension-converter .output/safari-mv3 \
  --app-name "Aloud" --bundle-identifier dev.souj.aloud --project-location safari --no-open --no-prompt
```

then: iOS 17.0 as the extension's deployment target (the converter writes 15.0), the Productivity
category on both apps, and the icons.

## Run it

Signing first, once: in Xcode, each of the four targets, Signing & Capabilities, Team: your Apple
ID (the project has none set, so that no team is committed).

**Mac:** scheme "Aloud (macOS)", Run. In Safari: Settings, Advanced, "Show features for web
developers"; Develop menu, "Allow Unsigned Extensions" (forgotten each time Safari quits; not
needed once the app is signed with a development team); Settings, Extensions, turn Aloud on and
allow it on websites.

**iPhone:** Developer Mode on (Settings, Privacy & Security). Connect it; scheme "Aloud (iOS)" with
the phone as destination (a free personal team runs on your own phone for 7 days). Run. On the
phone: Settings, Apps, Safari, Extensions, Aloud: on, all websites. In Safari, the page menu ("Aa"
or the extensions icon), Aloud.

**Debugging:** Safari's Develop menu shows "Web Extension Background Content" for Aloud's
background, and a connected iPhone's pages and extension. The synthesis frame is listed under the
page it is in, as `synth-host.html`.

## What to test first, and what is likely to need work

1. **Does the button do anything?** Click Aloud on an article: the reading bar should appear. If
   nothing happens, the background did not load: Develop, Web Extension Background Content, and
   read its console.
2. **Read an article with Phonon.** The first use downloads about 100 MB, then reads. Then **read
   on a second site**: the voice should be there already. Safari may keep the storage of a frame
   inside a web page apart for each site (the synthesis frame is one), in which case the voice
   downloads again on every site; that would need the downloads moved to the background, and is
   the most likely real problem left.
3. Play on an iPhone needs a tap in the page: the bar says "Press ▶ to start" when the toolbar's
   tap did not count as one. Check that it plays with the ring switch on silent.
4. On iPhone: Safari's memory limits for extensions, with the model loaded (about 300 MB).
5. Supertonic (about 400 MB; marked as heavy for a phone).
6. A PDF; a note (N or the bar's bookmark) and its highlight; the Library.
7. Dropbox sync: Connect shows the code step (no identity API); notes and places sync with a
   Firefox or Chrome device.
8. Keyboard shortcuts and the right-click menu: Mac only (Settings, Shortcuts says Safari sets them
   itself). On iPhone there are none, as on Firefox for Android.

## Submitting

Archive each scheme in Xcode (Product, Archive) with a distribution team, and upload from the
Organizer. Before that: the App Store exception in Aloud's licence (above), and App Store Connect's
own listing, screenshots and privacy answers (the extension's are in docs/STORE_LISTING.md).

The Firefox and Chrome builds are unaffected by all of this: their packages and checks are as before
(`npm run build:chrome && npm run test:e2e:chromium`).
