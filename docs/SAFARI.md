# Aloud for Safari (Mac and iPhone)

The Safari build is the same extension with fewer engines, wrapped in a small native app that Xcode
builds: Safari extensions ship through the App Store, for Mac and iPhone alike.

## What is in it, and why

- **Phonon, Supertonic and the reader's own server.** No Piper and no Kokoro: both read through
  eSpeak-NG (GPL-3.0), and the App Store's terms do not allow GPL code. Nothing of eSpeak goes into
  the Safari package:
  - The worker is built with `__ALOUD_ESPEAK__` false (scripts/build-worker.mjs), so Piper's and
    Kokoro's imports are dropped from engine/worker-main.ts and their chunks are never emitted.
  - `vendor/piper/` is left out of the package (wxt.config.ts, `build:publicAssets`).
  - shared/engine-catalog.ts offers only the three engines.

  Check after any change: `grep -rIl -i "piper_phonemize" .output/safari-mv3` finds nothing, and
  `.output/safari-mv3/vendor/rt/` holds only phonon.js, server.js and supertonic.js.
- **No `identity` permission.** Safari has no identity API, so Dropbox sign-in uses the code Dropbox
  shows, as on Firefox for Android (options/dropbox-panel.ts already does this when
  `browser.identity` is missing).
- **Safari 17 and later** (`vite.build.target`): the CSS Custom Highlight API arrived in 17.2.
- **Aloud's own code is GPL-3.0.** Before an App Store submission, its author adds an App Store
  exception to Aloud's own licence. The third-party code left in the package (ONNX Runtime, pdf.js,
  Readability, phonon-tts, lamejs and others) is MIT, Apache-2.0 or LGPL.

## Build on the Mac

Node 22 and npm (as BUILD.md), then from the repository:

```bash
npm ci
npm run build:safari        # .output/safari-mv3
```

The first time only, make the Xcode project in `safari/`, beside the build it wraps:

```bash
xcrun safari-web-extension-converter .output/safari-mv3 \
  --app-name "Aloud" --bundle-identifier dev.souj.aloud --project-location safari --no-open
```

Then check that the project refers to `.output/safari-mv3` by a path **relative** to the project, not
`/Users/...`: in Xcode, select the extension's resources folder, File inspector, Location "Relative
to Project". Commit `safari/` (Xcode's per-user files are ignored). After that, a change to the
extension is `npm run build:safari` and Run in Xcode.

## Run it

**Mac:** scheme "Aloud (macOS)", Run. In Safari: Settings, Advanced, "Show features for web
developers"; Develop menu, "Allow Unsigned Extensions" (forgotten each time Safari quits); Settings,
Extensions, turn Aloud on and allow it on websites.

**iPhone:** Developer Mode on (Settings, Privacy & Security). Connect it; scheme "Aloud (iOS)" with
the phone as destination; Signing & Capabilities, Team: your Apple ID (a free personal team runs on
your own phone for 7 days). Run. On the phone: Settings, Apps, Safari, Extensions, Aloud: on, all
websites. In Safari, the page menu ("Aa" or the extensions icon), Aloud.

**Debugging:** Safari's Develop menu shows "Web Extension Background Content" for Aloud's
background, and a connected iPhone's pages and extension.

## What to test first, and what is likely to need work

1. Read an article with Phonon: the first use downloads about 100 MB, then reads. On iPhone this is
   the big unknown: Safari's memory limits for extensions, and its storage quota for the model.
2. Supertonic (about 400 MB; probably too heavy for a phone).
3. A PDF; a note (N or the bar's bookmark) and its highlight; the Library.
4. Dropbox sync: Connect shows the code step (no identity API); notes and places sync with a
   Firefox or Chrome device.
5. Keyboard shortcuts and the right-click menu: Mac only, as on Firefox for Android there are none on
   iPhone.

The Firefox and Chrome builds are unaffected by all of this: their packages and checks are as before
(`npm run build:chrome && npm run test:e2e:chromium`).
