// Builds the synthesis Worker to .gen/worker/tts-worker.js (an ES-module worker).
// prebuild.mjs copies it into public/.
//
// onnxruntime-web is NOT imported statically anywhere in the worker graph — it is loaded at
// run time by URL (see src/engine/ort-loader.ts) so Vite never inlines its multi-megabyte
// .wasm files. The transformers web bundle references ORT only through its own webpack runtime
// string table, which Rollup does not follow.
import { build } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stub = resolve(root, 'src/worker/empty-stub.ts');

// One worker bundle serves both browsers: esbuild takes the lowest common denominator of these
// baselines, and the worker's own browser differences are runtime capability checks
// (src/shared/browser-env.ts), not build-time ones. Keeping a single bundle also means the
// generated files copied into the shared public/ directory can't be clobbered by whichever
// browser was built last.
const BROWSER_TARGETS = ['firefox128', 'chrome120'];

/**
 * transformers.js points ONNX Runtime at its WebAssembly on cdn.jsdelivr.net whenever no path is set
 * yet. Aloud always sets the packaged one first (src/engine/ort-loader.ts), so the line never runs.
 *
 * The two stores want opposite things of that dead line:
 *  - Chrome asks that code able to load from elsewhere be removed, not merely left unused ("remote
 *    hosted code": what to do if the code isn't being used). The Chrome build drops that one line
 *    from the bundled copy, and nothing else. If an update to transformers.js changes the line, the
 *    build stops here rather than ship a CDN path again.
 *  - Mozilla does not allow third-party libraries to be modified at all ("Modifications to these
 *    libraries/frameworks are not permitted"). The Firefox build bundles transformers.js exactly as
 *    published on npm; the line stays, unreachable, and Firefox's extension CSP would refuse a
 *    remote script in any case.
 * The ONNX Runtime files themselves are copied unmodified for both (sync-assets.mjs).
 */
const TRANSFORMERS_CDN_DEFAULT =
  'ONNX_ENV.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${_env_js__WEBPACK_IMPORTED_MODULE_0__.env.version}/dist/`;';

const noCdnDefault = {
  name: 'aloud-no-cdn-default',
  transform(code, id) {
    if (!/[\\/]@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.web\.js$/.test(id)) return null;
    if (!code.includes(TRANSFORMERS_CDN_DEFAULT)) {
      throw new Error(`[build-worker] transformers.js no longer has the CDN default this build removes — check ${id}`);
    }
    return {
      code: code.replace(TRANSFORMERS_CDN_DEFAULT, '/* Aloud: no CDN — ONNX Runtime ships in the extension (vendor/ort/), set by ort-loader.ts */'),
      map: null,
    };
  },
};

export async function buildWorker(options) {
  const minify = !(options && options.minify === false);
  const browser = options?.browser ?? 'firefox';
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: {
      alias: {
        '@': resolve(root, 'src'),
        path: stub,
        'fs/promises': stub,
        fs: stub,
        'onnxruntime-node': stub,
      },
      conditions: ['browser', 'import', 'default'],
    },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    worker: { format: 'es' },
    plugins: browser === 'firefox' ? [] : [noCdnDefault],
    build: {
      target: BROWSER_TARGETS,
      outDir: '.gen/worker',
      emptyOutDir: true,
      // Vite otherwise copies <root>/public/* into outDir *after* bundling — and public/ holds a
      // previous copy of tts-worker.js, so that clobbers the fresh build with a stale one.
      copyPublicDir: false,
      minify,
      chunkSizeWarningLimit: 20000,
      modulePreload: false,
      rollupOptions: {
        input: resolve(root, 'src/worker/entry.ts'),
        // onnxruntime-web / -common are provided at run time as a real ESM module served from
        // the extension package. Keeping them external stops Vite inlining ORT's ~30 MB of
        // .wasm. `output.paths` rewrites the bare specifier to that URL, because module workers
        // have no import maps in either browser. It is the same file ort-loader loads, so Kokoro's
        // transformers.js and Piper share one runtime instance (see ort-loader).
        external: ['onnxruntime-web', 'onnxruntime-common'],
        output: {
          format: 'es',
          entryFileNames: 'tts-worker.js',
          // Stable names, so one release compares with the next file by file (see wxt.config.ts).
          chunkFileNames: 'vendor/rt/[name].js',
          assetFileNames: 'vendor/rt/[name][extname]',
          paths: {
            'onnxruntime-web': './vendor/ort/ort.bundle.min.mjs',
            'onnxruntime-common': './vendor/ort/ort.bundle.min.mjs',
          },
          // `output.paths` above is emitted verbatim into every chunk that imports ORT, but the
          // Kokoro path is now a lazily-imported chunk under `vendor/rt/`, from where
          // `./vendor/ort/…` does not resolve. Rebase the (fixed, known) specifier to the chunk's
          // own depth so it points back at `vendor/ort/`.
          plugins: [
            {
              name: 'rebase-ort-external-specifier',
              renderChunk(code, chunk) {
                const depth = chunk.fileName.split('/').length - 1;
                if (depth === 0) return null;
                const prefix = '../'.repeat(depth);
                const rebased = code.replace(
                  /(["'])\.\/vendor\/ort\/ort\.bundle\.min\.mjs\1/g,
                  `$1${prefix}vendor/ort/ort.bundle.min.mjs$1`,
                );
                return rebased === code ? null : { code: rebased, map: null };
              },
            },
          ],
        },
        onwarn(warning, warn) {
          const msg = warning && warning.message ? warning.message : '';
          if (warning.code === 'UNRESOLVED_IMPORT') return;
          if (msg.indexOf('will not be analyzed') !== -1) return;
          if (msg.indexOf('Use of eval') !== -1) return;
          warn(warning);
        },
      },
    },
  });
  console.log('[build-worker] .gen/worker/tts-worker.js built');
}

/**
 * Builds the tiny synthesis-host page script to .gen/worker/synth-host.js as a plain IIFE.
 *
 * It must NOT be an ES module with a `crossorigin` attribute (what a bundler HTML entrypoint
 * emits): when public/synth-host.html is framed by web content, a `crossorigin` module script
 * fails to load because extension resources send no CORS headers, leaving the page inert.
 * A same-origin classic `<script src>` has no such problem.
 */
export async function buildSynthHost(options) {
  const minify = !(options && options.minify === false);
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@': resolve(root, 'src') }, conditions: ['browser', 'import', 'default'] },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      target: BROWSER_TARGETS,
      outDir: '.gen/worker',
      emptyOutDir: false,
      // Critical: without this Vite copies public/* (including a stale tts-worker.js) over the
      // fresh output from buildWorker() that ran just before this.
      copyPublicDir: false,
      minify,
      modulePreload: false,
      rollupOptions: {
        input: resolve(root, 'src/synth-host/entry.ts'),
        output: { format: 'iife', entryFileNames: 'synth-host.js' },
      },
    },
  });
  console.log('[build-worker] .gen/worker/synth-host.js built');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  buildWorker()
    .then(() => buildSynthHost())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
