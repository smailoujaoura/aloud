import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// Firefox-only Manifest V3 build.
//
// Architecture notes that this config encodes:
//  - The synthesis engine runs in a Web Worker loaded from `/tts-worker.js`. It must be a
//    web-accessible resource so a content script (in an arbitrary page) can spawn it from a
//    `moz-extension://` URL, which gives the worker the *extension* origin + CSP (and therefore
//    `wasm-unsafe-eval`), regardless of the host page's CSP.
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
  browser: 'firefox',

  manifest: {
    name: 'Aloud — Offline Neural Reader',
    short_name: 'Aloud',
    description:
      'Fast, fully offline text-to-speech. Extracts the article, reads it aloud with a local neural voice (Piper / Kokoro), and highlights each sentence as it plays.',

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
    ],

    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },

    // The worker and its ORT runtime must be reachable from a `moz-extension://` URL so a
    // content script on any page can spawn the worker at the extension origin.
    web_accessible_resources: [
      {
        // `synth-host.html` is the hidden iframe the content script loads to host the synthesis
        // Worker (Firefox forbids content scripts from spawning a moz-extension: Worker directly).
        // `vendor/rt/*` holds the worker's lazily-imported engine chunks (Piper / Kokoro / the
        // ORT loader) produced by scripts/build-worker.mjs.
        resources: [
          'synth-host.html',
          'synth-host.js',
          'tts-worker.js',
          'vendor/rt/*',
          'vendor/ort/*',
          'models.json',
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
    },

    browser_specific_settings: {
      gecko: {
        id: 'aloud@offline-tts.mozilla.org',
        // 142+: clears the last web-ext lint warning (Android data_collection_permissions support).
        strict_min_version: '142.0',
        // The extension is fully offline and transmits nothing.
        data_collection_permissions: { required: ['none'] },
      },
    },
  },

  hooks: {
    'build:before'() {
      execFileSync(process.execPath, ['scripts/prebuild.mjs'], { stdio: 'inherit' });
    },
  },

  vite: () => ({
    build: {
      target: 'firefox128',
      chunkSizeWarningLimit: 8192,
    },
  }),
});
