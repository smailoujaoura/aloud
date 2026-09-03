/**
 * Grapheme-to-phoneme via eSpeak-NG, compiled to WebAssembly and shipped (with its data files)
 * inlined inside the `phonemizer` package — nothing to vendor, works in a Worker.
 *
 * Note: eSpeak-NG is GPLv3; bundling it makes the whole extension GPLv3 (see LICENSE).
 */
import { phonemize as espeakPhonemize } from 'phonemizer';

// Cache promises per language so the WASM module + voice load once.
const warm = new Map<string, Promise<void>>();

export async function phonemize(text: string, language = 'en-us'): Promise<string> {
  if (!text.trim()) return '';
  if (!warm.has(language)) {
    warm.set(
      language,
      espeakPhonemize('warm up', language).then(
        () => undefined,
        () => undefined,
      ),
    );
  }
  await warm.get(language);

  const lines: string[] = await espeakPhonemize(text, language);
  // `phonemize` returns one entry per input line; re-join with a spoken-pause space.
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/** Map a BCP-47-ish language tag to an eSpeak voice name. */
export function toEspeakVoice(lang: string): string {
  const l = lang.toLowerCase();
  const table: Record<string, string> = {
    en: 'en-us',
    'en-us': 'en-us',
    'en-gb': 'en-gb',
    fr: 'fr-fr',
    de: 'de',
    es: 'es',
    it: 'it',
    pt: 'pt',
    'pt-br': 'pt-br',
    nl: 'nl',
    pl: 'pl',
    ru: 'ru',
    uk: 'uk',
    tr: 'tr',
    sv: 'sv',
    da: 'da',
    nb: 'nb',
    fi: 'fi',
    cs: 'cs',
    el: 'el',
    hu: 'hu',
    ro: 'ro',
    hi: 'hi',
    id: 'id',
    vi: 'vi',
    zh: 'cmn',
    ja: 'ja',
    ko: 'ko',
    ar: 'ar',
  };
  return table[l] ?? table[l.split('-')[0] ?? 'en'] ?? 'en-us';
}
