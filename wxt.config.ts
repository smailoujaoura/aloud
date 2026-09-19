import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// Cross-browser Manifest V3 build (Firefox / Chromium).
//
// Pick the target with `--browser firefox` or `--browser chrome`; the npm scripts wrap both.
// The two outputs differ in exactly three ways, all handled below:
//
//  1. **Background.** WXT emits `background.scripts` (a Gecko event page) for Firefox and
//     `background.service_worker` for Chromium. Loading the *Firefox* output in Chrome is what
//     produces "'background.scripts' requires manifest version of 2 or lower" — and, because the
//     background then never runs, a toolbar button that does nothing. Always load the folder that
//     matches the browser: `.output/firefox-mv3` or `.output/chrome-mv3`.
//  2. **`browser_specific_settings`.** Gecko-only; Chromium logs it as an unrecognized key.
//  3. **Build target.** Different baseline engine versions.
//
// Architecture notes that this config encodes:
//  - The synthesis engine runs in a Web Worker loaded from `/tts-worker.js`. It must be a
//    web-accessible resource so a content script (in an arbitrary page) can reach it at the
//    *extension* origin + CSP (and therefore `wasm-unsafe-eval`), regardless of the host page's
//    CSP. Firefox additionally forbids a content script from constructing that Worker directly,
//    which is why `synth-host.html` exists — see src/engine/worker-client.ts.
//  - All ONNX Runtime Web / eSpeak-NG WASM + loader assets are vendored under `public/vendor/`
//    and loaded at runtime by URL; ORT's default CDN fetch is blocked by our CSP.
//  - The content script is NOT declared in the manifest. It is injected on demand with
//    `browser.scripting.executeScript` when the user activates the extension on a tab.
export default defineConfig({
  srcDir: 'src',
  entrypointsDir: 'entrypoints',
  publicDir: `${rootDir}public`,
  outDir: '.output',
  manifestVersion: 3,

  manifest: ({ browser }) => ({
    name: 'Aloud — Offline Neural Reader',
    short_name: 'Aloud',
    description:
      'Fast, fully offline text-to-speech. Extracts the article, reads it aloud with a local neural voice, and highlights each sentence as it plays.',

    permissions: ['activeTab', 'scripting', 'storage', 'unlimitedStorage', 'contextMenus', 'tabs'],

    // Model files are served with `Access-Control-Allow-Origin: *`, so downloads work without
    // these; declaring them removes CORS from the equation for the extension-origin worker and
    // future-proofs against Hugging Face tightening headers.
    host_permissions: [
      'https://huggingface.co/*',
      'https://*.hf.co/*',
      'https://cdn-lfs.huggingface.co/*',
      'https://cdn-lfs-us-1.huggingface.co/*',
      'https://cdn-lfs-eu-1.huggingface.co/*',
      // Local PDFs. Chromium only: this is what makes `fetch('file:///…')` work *once the user
      // also switches on "Allow access to file URLs"* for the extension — verified empirically;
      // without the permission the fetch fails even with the toggle on. Gecko never grants
      // add-ons file access (bug 1266960), so declaring it there would be a permission warning
      // in exchange for nothing: on Firefox the PDF page falls back to its file picker.
      ...(browser === 'firefox' ? [] : ['file:///*']),
    ],

    /**
     * Asked for one site at a time, only when a PDF cannot be fetched without it.
     *
     * A PDF linked from a website is served from that site, and reading it means downloading it
     * — which is a cross-origin request the extension has no standing permission to make, so it
     * fails CORS however the file is served. `activeTab` does not help: the tab is showing the
     * browser's own PDF viewer, not a page we were invoked on.
     *
     * Declaring `<all_urls>` outright would be a "read all your data on every website" warning
     * for a reader that never touches a site until you point it at a PDF there. So the reader
     * page asks for the one origin, at the moment it needs it, from the user's own click — and
     * once granted it stays granted for that site.
     */
    optional_host_permissions: ['*://*/*'],

    /**
     * Firefox only, asked for on the first "Save" of an annotated PDF. Firefox has no File System
     * Access API, so the downloads API's "Save as" dialog is the only way to let the user put the
     * annotated file back over the original. Chromium saves through its own file dialog instead.
     */
    ...(browser === 'firefox' ? { optional_permissions: ['downloads'] } : {}),

    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },

    // The worker and its ORT runtime must be reachable from the extension origin so a content
    // script on any page can host the worker there.
    web_accessible_resources: [
      {
        // `synth-host.html` is the hidden iframe the content script loads to host the synthesis
        // Worker. `vendor/rt/*` holds the worker's lazily-imported engine chunks (Piper / Kokoro /
        // Supertonic / the ORT loader) produced by scripts/build-worker.mjs.
        resources: [
          'synth-host.html',
          'synth-host.js',
          'tts-worker.js',
          'vendor/rt/*',
          'vendor/ort/*',
          // piper_phonemize's WASM and eSpeak data, loaded by the synthesis worker.
          'vendor/piper/*',
          'models.json',
          // Artwork for the OS media overlay; loaded from the page, so it must be web-accessible.
          'icon/128.png',
        ],
        matches: ['<all_urls>'],
      },
    ],

    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      96: '/icon/96.png',
      128: '/icon/128.png',
    },

    action: {
      default_title: 'Read this page aloud (Alt+Shift+R)',
      default_icon: {
        16: '/icon/16.png',
        32: '/icon/32.png',
        48: '/icon/48.png',
        96: '/icon/96.png',
      },
    },

    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },

    commands: {
      'toggle-read': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Start / stop reading the current page aloud',
      },
      'save-note': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save what you just heard (or the selected text) to Notes',
      },
      'back-a-little': {
        suggested_key: { default: 'Alt+Shift+Comma' },
        description: 'Back a little: replay the last few seconds',
      },
      'media-speed': {
        suggested_key: { default: 'Alt+Shift+V' },
        description: 'Control this page’s video / audio speed from the keyboard',
      },
      // Chromium allows four suggested shortcuts, all taken; there it is set at
      // chrome://extensions/shortcuts (and Alt+Shift+S with nothing selected shows the panel too).
      'notes-panel': {
        ...(browser === 'firefox' ? { suggested_key: { default: 'Alt+Shift+N' } } : {}),
        description: 'Show your notes on this page',
      },
    },

    // Gecko-only. Chromium logs unknown top-level keys as warnings on load, so keep it out of
    // the Chrome manifest entirely.
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'aloud@offline-tts.mozilla.org',
              // 142+: native CSS Custom Highlight API, and Android
              // `data_collection_permissions` support (the last web-ext lint warning).
              strict_min_version: '142.0',
              // The extension is fully offline and transmits nothing.
              data_collection_permissions: { required: ['none'] },
            },
            // Firefox for Android. `gecko_android` is what makes the listing installable there;
            // without it AMO treats the add-on as desktop-only.
            gecko_android: { strict_min_version: '142.0' },
          },
        }
      : {}),
  }),

  hooks: {
    // Builds the synthesis worker + vendored runtime into public/. Browser-agnostic: one worker
    // bundle serves both targets (see scripts/build-worker.mjs).
    'build:before'() {
      execFileSync(process.execPath, ['scripts/prebuild.mjs'], { stdio: 'inherit' });
    },
  },

  vite: (env) => ({
    build: {
      // The worker bundle is built separately (scripts/build-worker.mjs) and targets the same
      // baselines; keep the two in step.
      target: env.browser === 'firefox' ? 'firefox128' : 'chrome120',
      chunkSizeWarningLimit: 8192,
      // Vite adds <link rel="modulepreload"> for every chunk an extension page imports. Chromium
      // refuses those for extension resources ("A preload … is not used because it is a
      // cross-world extension resource mismatch") and then warns again that each was never used,
      // which buried real errors in every page's console. The chunks are local files, so
      // preloading them gains nothing anyway.
      modulePreload: false,
    },
  }),
});
