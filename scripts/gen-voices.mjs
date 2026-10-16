// Regenerates public/models.json:
//   - `piper`  : the rhasspy/piper-voices catalogue at PIPER_REV, less the voices Aloud cannot
//                phonemize (PIPER_UNSUPPORTED),
//                each with its onnx + config URLs, download size and a hosted preview clip.
//   - `kokoro` : the voice list from the onnx-community Kokoro repo, with derived language/gender.
//   - `supertonic` and everything else: passed through verbatim from scripts/models.base.json.
//
// Network fetches are cached under .gen/voices/ so offline rebuilds keep working. The merged
// file is written to public/models.json AND committed, so `npm test` / partial builds don't
// need the network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.gen/voices');

// Pinned so the build is reproducible. Bump deliberately; see BUILD.md.
const PIPER_REV = '39ab474be869e9181350af6a65e4953eef67aaa0';
const PIPER_BASE = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REV}`;
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';

async function cachedJson(name, url) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, name);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const json = await res.json();
  writeFileSync(file, JSON.stringify(json));
  return json;
}

const titleCase = (s) =>
  s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Voices whose config asks for a phonemizer Aloud does not have (`phoneme_type` other than espeak
 * or text). Fed eSpeak phonemes they cannot speak: the Chinese voices fail inside ONNX Runtime,
 * and the others produce the wrong sounds. Left out until there is a phonemizer for them; the
 * engine also refuses them at start-up (engines/piper.ts: SUPPORTED_PHONEME_TYPES).
 */
const PIPER_UNSUPPORTED = {
  'zh_CN-chaowen-medium': 'pinyin',
  'zh_CN-xiao_ya-medium': 'pinyin',
  'ja_JA-hi_fi_captain-medium': 'japanese',
  'he_IL-saspeech-medium': 'hebrew',
};

function buildPiper(voicesJson) {
  const out = {};
  for (const [key, v] of Object.entries(voicesJson)) {
    if (key in PIPER_UNSUPPORTED) continue;
    const paths = Object.keys(v.files);
    const onnxPath = paths.find((p) => p.endsWith('.onnx'));
    const cfgPath = paths.find((p) => p.endsWith('.onnx.json'));
    if (!onnxPath || !cfgPath) continue;
    const dir = onnxPath.slice(0, onnxPath.lastIndexOf('/'));
    const lang = v.language;
    const region = lang.region ? ` (${lang.region})` : '';
    out[key] = {
      label: `${titleCase(v.name)} — ${lang.name_english}${region}`,
      language: lang.code.replace('_', '-'),
      languageName: lang.name_english,
      quality: v.quality,
      onnx: `${PIPER_BASE}/${onnxPath}`,
      config: `${PIPER_BASE}/${cfgPath}`,
      license: 'see MODEL_CARD (per-voice; rhasspy/piper-voices)',
      sizeBytes: (v.files[onnxPath]?.size_bytes ?? 0) + (v.files[cfgPath]?.size_bytes ?? 0),
      sample: `${PIPER_BASE}/${dir}/samples/speaker_0.mp3`,
      numSpeakers: v.num_speakers ?? 1,
    };
  }
  // Sort by language then voice name for a tidy, diff-friendly file.
  return Object.fromEntries(
    Object.entries(out).sort((a, b) =>
      (a[1].languageName + a[0]).localeCompare(b[1].languageName + b[0]),
    ),
  );
}

const KOKORO_LANG = {
  a: { code: 'en-US', name: 'English (US)' },
  b: { code: 'en-GB', name: 'English (UK)' },
  e: { code: 'es', name: 'Spanish' },
  f: { code: 'fr-FR', name: 'French' },
  h: { code: 'hi', name: 'Hindi' },
  i: { code: 'it', name: 'Italian' },
  j: { code: 'ja', name: 'Japanese' },
  p: { code: 'pt-BR', name: 'Portuguese (BR)' },
  z: { code: 'zh', name: 'Mandarin' },
};
/**
 * Voice-id prefixes (the language letter) Aloud can synthesise: US and UK English through
 * kokoro-js, and Spanish, French, Hindi, Italian and Brazilian Portuguese through eSpeak-NG
 * (engines/kokoro.ts: ESPEAK_LANGUAGE). Not Japanese or Mandarin: Kokoro reads those through
 * phonemisers with no browser equivalent.
 */
const KOKORO_SUPPORTED_PREFIXES = new Set(['a', 'b', 'e', 'f', 'h', 'i', 'p']);

// Quality grades from the Kokoro-82M voice table, where published.
const KOKORO_GRADE = {
  af_heart: 'A', af_bella: 'A-', af_nicole: 'B-', bf_emma: 'B-', af_kore: 'C+', af_sarah: 'C+',
  af_aoede: 'C+', am_fenrir: 'C+', am_michael: 'C+', am_puck: 'C+', bf_isabella: 'C', bm_george: 'C',
  bm_fable: 'C', af_sky: 'C-', am_echo: 'D', am_eric: 'D', am_liam: 'D', am_onyx: 'D',
  ff_siwis: 'B-', hf_alpha: 'C', hf_beta: 'C', hm_omega: 'C', hm_psi: 'C', if_sara: 'C', im_nicola: 'C',
};

function buildKokoro(hfInfo) {
  const voices = {};
  const bins = hfInfo.siblings
    .map((s) => s.rfilename)
    .filter((f) => f.startsWith('voices/') && f.endsWith('.bin'))
    .map((f) => f.slice('voices/'.length, -'.bin'.length))
    .sort();
  for (const id of bins) {
    if (!id.includes('_')) continue; // skip the blended base vectors ("af", "am")
    // The Hugging Face repo carries style vectors for nine languages. Only those Aloud can
    // phonemise are listed: a voice that cannot speak is worse than no voice.
    if (!KOKORO_SUPPORTED_PREFIXES.has(id[0])) continue;
    const lang = KOKORO_LANG[id[0]] ?? { code: 'en-US', name: 'English (US)' };
    const gender = id[1] === 'm' ? 'male' : 'female';
    const entry = { label: titleCase(id.split('_')[1]), language: lang.code, gender };
    if (KOKORO_GRADE[id]) entry.grade = KOKORO_GRADE[id];
    voices[id] = entry;
  }
  return voices;
}

async function main() {
  const [piperVoices, kokoroInfo] = await Promise.all([
    cachedJson('piper-voices.json', `${PIPER_BASE}/voices.json`),
    cachedJson('kokoro.json', `https://huggingface.co/api/models/${KOKORO_REPO}?blobs=true`),
  ]);

  const base = JSON.parse(readFileSync(join(root, 'scripts/models.base.json'), 'utf8'));
  const merged = {
    $comment: `Generated by scripts/gen-voices.mjs. piper @ ${PIPER_REV}. Do not edit by hand.`,
    piper: buildPiper(piperVoices),
    kokoro: { ...base.kokoro, voices: buildKokoro(kokoroInfo) },
    supertonic: base.supertonic,
  };

  const dest = join(root, 'public/models.json');
  writeFileSync(dest, JSON.stringify(merged, null, 2) + '\n');
  console.log(
    `[gen-voices] models.json: ${Object.keys(merged.piper).length} Piper, ` +
      `${Object.keys(merged.kokoro.voices).length} Kokoro, ` +
      `${Object.keys(merged.supertonic.voices).length} Supertonic`,
  );
}

export async function genVoices() {
  try {
    await main();
  } catch (err) {
    if (existsSync(join(root, 'public/models.json'))) {
      console.warn(`[gen-voices] using existing public/models.json (${err.message})`);
      return;
    }
    throw err;
  }
}

if (import.meta.url === 'file://' + process.argv[1]) genVoices();
