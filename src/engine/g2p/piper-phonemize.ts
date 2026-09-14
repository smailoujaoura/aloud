/**
 * Text → phonemes for Piper voices, with the same phonemiser Piper's voices were trained on.
 *
 * `piper_phonemize` is rhasspy's own eSpeak-NG fork compiled to WASM, with eSpeak data for every
 * language it supports. It replaces the `phonemizer` package, which bundles English data only:
 * with it every non-English Piper voice failed on every sentence ("Invalid language identifier:
 * \"fr\""), and the failure was invisible because a sentence that cannot be synthesised is
 * replaced by silence.
 *
 * The files (`.js` glue, `.wasm`, and an 18 MB `.data` package of eSpeak data) are vendored to
 * `vendor/piper/` and loaded from the extension. Two Emscripten hooks do the loading, because the
 * glue's own environment detection does not recognise a *module* worker — no `window`, no
 * `importScripts` — and would otherwise treat it as a bare shell with no way to fetch anything.
 * The module is created once per worker and reused for every sentence.
 *
 * eSpeak-NG is GPLv3, which the extension already is (see LICENSE).
 */
import createPiperPhonemize, { type PiperPhonemizeModule } from '@diffusionstudio/piper-wasm/build/piper_phonemize.js';
import { assetUrl } from '@/engine/runtime-env';

let loading: Promise<PiperPhonemizeModule> | null = null;
/** Lines the module printed during the current call — one JSON object per sentence. */
let printed: string[] = [];
let complaints: string[] = [];

function load(): Promise<PiperPhonemizeModule> {
  loading ??= (async () => {
    const fetchBytes = async (file: string): Promise<ArrayBuffer> => {
      const res = await fetch(assetUrl(`vendor/piper/${file}`));
      if (!res.ok) throw new Error(`could not load ${file} (${res.status})`);
      return res.arrayBuffer();
    };
    const [wasm, data] = await Promise.all([fetchBytes('piper_phonemize.wasm'), fetchBytes('piper_phonemize.data')]);
    return createPiperPhonemize({
      print: (line) => printed.push(line),
      printErr: (line) => complaints.push(line),
      locateFile: (file) => assetUrl(`vendor/piper/${file}`),
      getPreloadedPackage: () => data,
      instantiateWasm: (imports, done) => {
        void WebAssembly.instantiate(wasm, imports).then(({ instance, module }) => done(instance, module));
        return {};
      },
    });
  })().catch((err) => {
    loading = null; // let the next sentence try again rather than failing forever
    throw err;
  });
  return loading;
}

/**
 * Phonemise `text` with eSpeak voice `voice` (a Piper config's `espeak.voice`: "fr", "en-us",
 * "cmn", …). Returns the IPA for the whole text as one string (in a one-element list, so a
 * caller can treat it as sentences).
 *
 * With `words`, each of those is also phonemised on its own, in the same call (eSpeak's start-up
 * is most of the cost, and one call pays it once). Those are what word timing aligns against.
 */
export async function phonemizeForPiper(text: string, voice: string): Promise<string[]>;
export async function phonemizeForPiper(
  text: string,
  voice: string,
  words: readonly string[],
): Promise<{ sentences: string[]; words: string[] }>;
export async function phonemizeForPiper(
  text: string,
  voice: string,
  words?: readonly string[],
): Promise<string[] | { sentences: string[]; words: string[] }> {
  if (!text.trim()) return words ? { sentences: [], words: words.map(() => '') } : [];
  const mod = await load();
  printed = [];
  complaints = [];
  const items = [{ text }, ...(words ?? []).map((word) => ({ text: word }))];
  mod.callMain(['-l', voice, '--input', JSON.stringify(items), '--espeak_data', '/espeak-ng-data']);
  if (printed.length === 0) {
    throw new Error(complaints.join(' ').trim() || `eSpeak produced no phonemes for voice "${voice}"`);
  }
  // One line per input item; `phonemes` is that item's IPA, one code point per entry.
  const ipa = printed.map((line) => (JSON.parse(line) as { phonemes: string[] }).phonemes.join(''));
  const sentences = ipa.slice(0, 1);
  if (!words) return sentences;
  const perWord = words.map((_, i) => ipa[i + 1] ?? '');
  return { sentences, words: ipa.length === items.length ? perWord : words.map(() => '') };
}
