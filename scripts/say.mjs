/**
 * Capture what Aloud actually says, as a WAV file.
 *
 * `npm run say -- --engine kokoro --voice af_heart --gpu`
 *
 * Every other check — "the worker replied", "audio came back", "N samples at 24 kHz" — passes on
 * audio that is not speech at all. Kokoro's quantised weights, for instance, load on WebGPU and
 * return audio of the right length for every sentence, but transcribing it gives back Mandarin.
 * So when an engine, its weights or its execution provider change, capture the audio here and
 * listen to it (or run it through any speech-to-text: the sentence should come back).
 *
 * Chromium only, headless, with the extension loaded from `.output/chrome-mv3` — build first.
 * `--gpu` asks for WebGPU (SwiftShader when there is no real adapter, which is enough to tell
 * speech from noise).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const engine = flag('engine', 'kokoro');
const voice = flag('voice', engine === 'piper' ? 'en_GB-alba-medium' : engine === 'kokoro' ? 'af_heart' : 'F1');
const text = flag('text', 'The quick brown fox jumps over the lazy dog.');
const gpu = args.includes('--gpu');
const out = flag('out', `${engine}-${voice}-${gpu ? 'gpu' : 'cpu'}.wav`);
const extension = flag('extension', new URL('../.output/chrome-mv3', import.meta.url).pathname);

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'aloud-say-')), {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    ...(gpu ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] : []),
  ],
});

try {
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (/ready on|failed to load|could not/i.test(m.text())) console.log(m.text().slice(0, 160));
  });
  // Any extension page will do: the worker has to be created at the extension origin.
  await page.goto(`chrome-extension://${id}/options.html`);

  const said = await page.evaluate(
    async ([engine, voice, text, wantGpu]) => {
      const synth = new Worker(chrome.runtime.getURL('/tts-worker.js'), { type: 'module' });
      const reply = (accept) =>
        new Promise((resolve, reject) => {
          const on = (e) => {
            if (accept(e.data)) {
              synth.removeEventListener('message', on);
              resolve(e.data);
            } else if (e.data?.kind === 'error' && e.data.fatal) {
              synth.removeEventListener('message', on);
              reject(new Error(e.data.message));
            }
          };
          synth.addEventListener('message', on);
        });
      synth.postMessage({
        kind: 'init',
        id: 1,
        config: { engine, voice, preferWebGPU: wantGpu, speed: 1, workers: 1, steps: 5 },
      });
      const ready = await reply((m) => m.kind === 'ready');
      synth.postMessage({ kind: 'synthesize', id: 2, chunkIndex: 0, text, speed: 1 });
      const audio = await reply((m) => m.kind === 'audio');
      synth.terminate();
      return { provider: ready.executionProvider, sampleRate: audio.sampleRate, pcm: Array.from(new Float32Array(audio.pcm)) };
    },
    [engine, voice, text, gpu],
  );

  writeFileSync(out, wav(said.pcm, said.sampleRate));
  console.log(`${engine}/${voice} on ${said.provider}: ${(said.pcm.length / said.sampleRate).toFixed(1)}s → ${out}`);
} finally {
  await ctx.close();
}

/** 16-bit PCM WAV, so anything can play or transcribe it. */
function wav(samples, sampleRate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  return bytes;
}
