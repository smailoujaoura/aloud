// The built synthesis worker, run by itself in a browser engine: a voice loaded, three sentences
// made, one of them again at 2x. No extension around it, so it runs in engines Playwright cannot
// load an extension into, WebKit above all: this is the nearest thing to Safari that can be run
// from a terminal, and what found that Safari never spoke (src/worker/entry.ts).
//
//   npm run build:safari && npm run test:engine:webkit
//   node scripts/engine-check.mjs <webkit|chromium> <build folder> [engine] [voice]
//   node scripts/engine-check.mjs chromium .output/chrome-mv3 piper en_GB-alba-medium
//
// It downloads the voice from Hugging Face each time (Phonon: 75 MB), and exits non-zero when the
// worker fails or returns silence. Needs `npx playwright install webkit` (or chromium).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import * as pw from 'playwright';

const [kind = 'webkit', dir = '.output/safari-mv3', engine = 'phonon', voice = 'NbpkqMVS3CJeq2j8'] = process.argv.slice(2);
const ROOT = resolve(dir);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/test.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>engine</title>');
  const path = join(ROOT, decodeURIComponent(url.pathname));
  if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await pw[kind].launch();
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/error|fail|warn/i.test(m.type()) || /\[aloud\]/.test(t)) console.log(`  [${m.type()}] ${t.slice(0, 300)}`); });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
await page.goto(`${origin}/test.html`);
const ua = await page.evaluate(() => navigator.userAgent);
console.log(kind, '·', ua.replace(/^.*?\) /, ''));
const result = await page.evaluate(async ({ engine, voice }) => {
  const worker = new Worker('/tts-worker.js', { type: 'module' });
  const log = [];
  const waitFor = (test, ms) => new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error(`timed out; last: ${JSON.stringify(log.slice(-3))}`)), ms);
    const on = (ev) => {
      const m = ev.data;
      if (m.kind === 'error') { clearTimeout(timer); worker.removeEventListener('message', on); return no(new Error(`[${m.phase}] ${m.message} | fatal=${m.fatal} | before: ${JSON.stringify(log.slice(-6))} | ${String(m.stack ?? '').slice(0, 300)}`)); }
      if (m.kind !== 'model-progress') log.push({ kind: m.kind, ...(m.message ? { message: m.message } : {}) });
      if (test(m)) { clearTimeout(timer); worker.removeEventListener('message', on); ok(m); }
    };
    worker.addEventListener('message', on);
  });
  const t0 = performance.now();
  worker.postMessage({ kind: 'init', id: 1, config: { engine, voice, preferWebGPU: true, speed: 1, debug: true } });
  const ready = await waitFor((m) => m.kind === 'ready', 600_000);
  const loadMs = performance.now() - t0;
  const sentences = [
    'The harbour was quiet that morning, and the gulls kept to the far end of the pier.',
    'Nobody had expected the ferry to arrive before noon, yet there it was, low in the water.',
    'She counted the crates twice, wrote the number down, and counted them again to be sure.',
  ];
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    const t = performance.now();
    worker.postMessage({ kind: 'synthesize', id: 10 + i, chunkIndex: i, text: sentences[i], speed: 1 });
    const audio = await waitFor((m) => m.kind === 'audio' && m.chunkIndex === i, 300_000);
    const pcm = new Float32Array(audio.pcm);
    let peak = 0; for (let k = 0; k < pcm.length; k += 7) peak = Math.max(peak, Math.abs(pcm[k]));
    out.push({ ms: Math.round(performance.now() - t), seconds: +(pcm.length / audio.sampleRate).toFixed(2), peak: +peak.toFixed(3), words: audio.words?.length ?? 0 });
  }
  // The same at 2x: Phonon's audio is stretched in the worker.
  const t2 = performance.now();
  worker.postMessage({ kind: 'synthesize', id: 20, chunkIndex: 9, text: sentences[0], speed: 2 });
  const fast = await waitFor((m) => m.kind === 'audio' && m.chunkIndex === 9, 300_000);
  worker.postMessage({ kind: 'dispose', id: 99 });
  return { provider: ready.executionProvider, sampleRate: ready.sampleRate, loadMs: Math.round(loadMs), out, at2x: { ms: Math.round(performance.now() - t2), seconds: +(new Float32Array(fast.pcm).length / fast.sampleRate).toFixed(2) }, log: log.filter((l) => l.kind === 'notice') };
}, { engine, voice }).catch((e) => ({ error: String(e).slice(0, 600) }));
console.log(JSON.stringify(result, null, 1));
// Sound, not merely samples: a voice that loads and returns silence has failed (#10).
if (result.out && result.out.some((o) => !(o.seconds > 1 && o.peak > 0.05))) result.error = 'a sentence came back silent or empty';
if (result.out) {
  const audio = result.out.reduce((n, o) => n + o.seconds, 0), work = result.out.reduce((n, o) => n + o.ms, 0) / 1000;
  console.log(`=> ${engine} on ${result.provider}: ${audio.toFixed(1)} s of speech in ${work.toFixed(1)} s (${(audio / work).toFixed(2)}x real time); model ready in ${(result.loadMs / 1000).toFixed(1)} s`);
}
await browser.close();
server.close();
if (result.error) console.error(`FAILED: ${result.error}`);
process.exit(result.error ? 1 : 0);
