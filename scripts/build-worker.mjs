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

export async function buildWorker(options) {
  const minify = !(options && options.minify === false);
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
        // have no import maps in either browser. The transformers bundle only actually touches
        // this import when globalThis[Symbol.for('onnxruntime')] is unset — which it never is
        // (see ort-loader).
        external: ['onnxruntime-web', 'onnxruntime-common'],
        output: {
          format: 'es',
          entryFileNames: 'tts-worker.js',
          chunkFileNames: 'vendor/rt/[name]-[hash].js',
          assetFileNames: 'vendor/rt/[name]-[hash][extname]',
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
