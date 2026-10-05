// Pre-build step: bundle the synthesis worker (.gen/worker) and copy its output into public/
// so WXT includes it in the extension. Runs from wxt.config.ts's build:before hook and from
// the `build` npm script.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker, buildSynthHost } from './build-worker.mjs';
import { syncAssets } from './sync-assets.mjs';
import { genVoices } from './gen-voices.mjs';
import { writeNotices } from './notices.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await genVoices();
syncAssets();
writeNotices();
await buildWorker({ minify: true });
await buildSynthHost({ minify: true });

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

console.log('[prebuild] worker + runtime assets copied into public/');
