/**
 * The website's voice samples: real Aloud audio, not a recording of somebody else.
 *
 * `npm run build && node scripts/site-samples.mjs`
 *
 * Each portrait on the site says one line about something Aloud does, and the hero demo reads its
 * article in Alba's voice with the word timings Piper reports — so the page shows exactly what the
 * extension does. Synthesis runs in headless Chromium through the built extension's own worker,
 * as scripts/say.mjs does; the result is encoded to MP3 with the same encoder as "Save as MP3".
 *
 * Writes website/assets/voices/*.mp3 and website/assets/voices/demo.json. With `--wav <dir>` it
 * also keeps WAV copies there, to transcribe: a sample is only worth shipping if it is speech.
 * Models are cached in `--profile <dir>` (default: a folder in the OS temp directory), so a second
 * run downloads nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mp3Encoder } from '@breezystack/lamejs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const extension = flag('extension', new URL('../.output/chrome-mv3', import.meta.url).pathname);
const profile = flag('profile', join(tmpdir(), 'aloud-site-samples'));
const wavDir = flag('wav', null);
const outDir = new URL('../website/assets/voices/', import.meta.url).pathname;
const only = flag('only', null);

/** Every face on the site, and what it says. Each line is something Aloud really does. */
export const SAMPLES = [
  { file: 'kokoro-af_heart', engine: 'kokoro', voice: 'af_heart', text: "Hi, I'm Heart. Open any article, press Alt R, and I'll read it to you." },
  { file: 'kokoro-bm_george', engine: 'kokoro', voice: 'bm_george', text: "I'm George. Every word I say is made right here, on your own computer." },
  { file: 'piper-alba', engine: 'piper', voice: 'en_GB-alba-medium', text: "I'm Alba. I work offline, so I'll keep reading on a train or a plane." },
  { file: 'kokoro-af_bella', engine: 'kokoro', voice: 'af_bella', text: "I'm Bella. I highlight each sentence as I read it, right where it sits on the page." },
  { file: 'kokoro-am_michael', engine: 'kokoro', voice: 'am_michael', text: "I'm Michael. Drifted off for a moment? One key takes you back ten seconds." },
  { file: 'piper-ryan', engine: 'piper', voice: 'en_US-ryan-medium', text: "I'm Ryan. I read PDFs too, and highlight the sentence on the real page." },
  { file: 'kokoro-bf_emma', engine: 'kokoro', voice: 'bf_emma', text: "I'm Emma. Going for a walk? Save any article as an MP3 and take me with you." },
  { file: 'kokoro-af_nicole', engine: 'kokoro', voice: 'af_nicole', text: "I'm Nicole. Close the tab whenever you like. I'll remember the sentence you stopped at." },
  { file: 'piper-cori', engine: 'piper', voice: 'en_GB-cori-medium', text: "I'm Cori. Select a passage and press K, and it's kept in your notes." },
  { file: 'kokoro-bm_fable', engine: 'kokoro', voice: 'bm_fable', text: "I'm Fable. No account, no subscription, and nothing you read is sent anywhere." },
  { file: 'kokoro-af_sarah', engine: 'kokoro', voice: 'af_sarah', text: "I'm Sarah. Slow me down, or speed me up. I'll tell you how many words a minute that is." },
  { file: 'kokoro-am_puck', engine: 'kokoro', voice: 'am_puck', text: "I'm Puck. Queue up a few articles, and I'll read them one after another." },
  { file: 'piper-northern_english_male', engine: 'piper', voice: 'en_GB-northern_english_male-medium', text: "Now then. Piper has a hundred and seventy-one voices, in forty-nine languages." },
  { file: 'kokoro-af_kore', engine: 'kokoro', voice: 'af_kore', text: "I'm Kore. I run on your graphics card when your browser allows it, and on your processor when it doesn't." },
  { file: 'kokoro-af_aoede', engine: 'kokoro', voice: 'af_aoede', text: "I'm Aoede. Reading a dark website? I keep the highlight easy on the eyes." },
  { file: 'kokoro-am_fenrir', engine: 'kokoro', voice: 'am_fenrir', text: "I'm Fenrir. I can even stop videos from playing by themselves." },
  // Supertonic 3: each voice speaks 31 languages, so each says its line in another one.
  { file: 'supertonic-F1-de', engine: 'supertonic', voice: 'F1@de', text: 'Ich lese Deutsch, Russisch, Japanisch und achtundzwanzig weitere Sprachen, alles auf diesem Gerät.' },
  { file: 'supertonic-M1-es', engine: 'supertonic', voice: 'M1@es', text: 'Leo artículos en español sin enviar nada a ningún sitio.' },
  { file: 'supertonic-F2-ja', engine: 'supertonic', voice: 'F2@ja', text: '日本語の記事も、この端末の中で読み上げます。' },
  { file: 'supertonic-M5-ru', engine: 'supertonic', voice: 'M5@ru', text: 'Я читаю по-русски, и всё это работает без интернета.' },
];

/** The hero demo: the article on the page, sentence by sentence, in Alba's voice. */
export const DEMO = {
  engine: 'piper',
  voice: 'en_GB-alba-medium',
  sentences: [
    'Every evening at dusk, the keeper climbed the spiral stairs to light the lamp.',
    'He wrote the weather in a ledger that nobody else would ever read.',
    'Wind from the west, visibility good, two boats heading north.',
    'The entries are short, but together they make a kind of diary of the sea.',
  ],
};

mkdirSync(outDir, { recursive: true });
if (wavDir) mkdirSync(wavDir, { recursive: true });

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);

  /** Synthesise `texts` in one voice: one worker, one model load, several sentences. */
  const say = (engine, voice, texts) =>
    page.evaluate(
      async ([engine, voice, texts]) => {
        const synth = new Worker(chrome.runtime.getURL('/tts-worker.js'), { type: 'module' });
        const reply = (accept) =>
          new Promise((resolve, reject) => {
            const on = (e) => {
              if (accept(e.data)) {
                synth.removeEventListener('message', on);
                resolve(e.data);
              } else if (e.data?.kind === 'error') {
                synth.removeEventListener('message', on);
                reject(new Error(e.data.message));
              }
            };
            synth.addEventListener('message', on);
          });
        synth.postMessage({ kind: 'init', id: 1, config: { engine, voice, preferWebGPU: false, speed: 1, workers: 1, steps: 5 } });
        await reply((m) => m.kind === 'ready');
        const out = [];
        for (let i = 0; i < texts.length; i++) {
          synth.postMessage({ kind: 'synthesize', id: 2 + i, chunkIndex: i, text: texts[i], speed: 1 });
          const audio = await reply((m) => m.kind === 'audio' && m.chunkIndex === i);
          out.push({ sampleRate: audio.sampleRate, pcm: Array.from(new Float32Array(audio.pcm)), words: audio.words ?? null });
        }
        synth.terminate();
        return out;
      },
      [engine, voice, texts],
    );

  for (const s of SAMPLES) {
    if (only && !s.file.includes(only)) continue;
    const t0 = Date.now();
    const [clip] = await say(s.engine, s.voice, [s.text]);
    const pcm = trim(clip.pcm, clip.sampleRate);
    writeFileSync(join(outDir, `${s.file}.mp3`), mp3(pcm, clip.sampleRate));
    if (wavDir) writeFileSync(join(wavDir, `${s.file}.wav`), wav(pcm, clip.sampleRate));
    console.log(`${s.file}: ${(pcm.length / clip.sampleRate).toFixed(1)}s in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  if (!only || 'demo'.includes(only)) {
    // One file for the whole article, with each sentence's place in it and Piper's word timings.
    const clips = await say(DEMO.engine, DEMO.voice, DEMO.sentences);
    const rate = clips[0].sampleRate;
    const gap = Math.round(rate * 0.12); // what the reader leaves between sentences, roughly
    const all = [];
    const sentences = [];
    for (let i = 0; i < clips.length; i++) {
      const offset = all.length / rate;
      all.push(...clips[i].pcm, ...new Array(gap).fill(0));
      sentences.push({
        start: +offset.toFixed(3),
        end: +((all.length - gap) / rate).toFixed(3),
        words: (clips[i].words ?? []).map((w) => ({
          word: DEMO.sentences[i].slice(w.from, w.to),
          start: +(offset + w.start).toFixed(3),
          end: +(offset + w.end).toFixed(3),
        })),
      });
    }
    writeFileSync(join(outDir, 'demo.mp3'), mp3(all, rate));
    writeFileSync(join(outDir, 'demo.json'), JSON.stringify({ voice: 'Alba', engine: 'Piper', duration: +(all.length / rate).toFixed(3), sentences }) + '\n');
    if (wavDir) writeFileSync(join(wavDir, 'demo.wav'), wav(all, rate));
    console.log(`demo: ${(all.length / rate).toFixed(1)}s, ${sentences.reduce((n, s) => n + s.words.length, 0)} timed words`);
  }
} finally {
  await ctx.close();
}

/** Drop near-silence at both ends, keeping a short breath either side. */
function trim(pcm, rate) {
  const loud = (v) => Math.abs(v) > 0.01;
  let a = pcm.findIndex(loud);
  let b = pcm.length - 1 - [...pcm].reverse().findIndex(loud);
  if (a < 0) return pcm;
  a = Math.max(0, a - Math.round(rate * 0.05));
  b = Math.min(pcm.length, b + Math.round(rate * 0.15));
  return pcm.slice(a, b);
}

function int16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  return out;
}

/** Mono MP3 at 64 kbps: clear speech, a few dozen kilobytes a sentence. */
function mp3(samples, rate) {
  const encoder = new Mp3Encoder(1, rate, 64);
  const pcm = int16(samples);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) parts.push(encoder.encodeBuffer(pcm.subarray(i, i + 1152)));
  parts.push(encoder.flush());
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

function wav(samples, rate) {
  const pcm = int16(samples);
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + pcm.length * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer).copy(bytes, 44);
  return bytes;
}
