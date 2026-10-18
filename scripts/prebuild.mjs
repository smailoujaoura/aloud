// Pre-build step: bundle the synthesis worker (.gen/worker) and copy its output into public/
// so WXT includes it in the extension. Runs from wxt.config.ts's build:before hook and from
// the `build` npm script.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker, buildSynthHost } from './build-worker.mjs';
import { syncAssets } from './sync-assets.mjs';
import { writeNotices } from './notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The voice catalogue (public/models.json) is committed and built from as it is: refreshing it from
// Hugging Face is a separate, deliberate step (`npm run voices`), reviewed as an ordinary diff. A
// release build needs nothing beyond `npm ci` — a store reviewer rebuilding the source gets the
// same catalogue, whatever the remote says that day.
syncAssets();
writeNotices();
// Not minified, for the same reason as the extension's own code (wxt.config.ts): reviewable diffs.
// The browser decides one thing in the worker: whether transformers.js is bundled as published
// (Firefox) or with its dead CDN line taken out (Chrome) — see build-worker.mjs.
const browser = process.argv[2] === 'chrome' ? 'chrome' : 'firefox';
await buildWorker({ minify: false, browser });
await buildSynthHost({ minify: false });

const gen = join(root, '.gen/worker');
const pub = join(root, 'public');

if (!existsSync(join(gen, 'tts-worker.js'))) {
  throw new Error('worker build produced no tts-worker.js');
}
if (!existsSync(join(gen, 'synth-host.js'))) {
  throw new Error('worker build produced no synth-host.js');
}

// Clear a previous copy of the generated runtime assets, then copy fresh.
rmSync(join(pub, 'vendor/rt'), { recursive: true, force: true });
mkdirSync(join(pub, 'vendor'), { recursive: true });
cpSync(gen, pub, { recursive: true });

console.log(`[prebuild] worker (${browser}) + runtime assets copied into public/`);
