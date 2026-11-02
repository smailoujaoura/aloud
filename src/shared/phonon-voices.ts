/**
 * Phonon's voices: what they speak, and which languages are experimental.
 *
 * Phonon S (31M) was trained on English. Gradium's catalogue (gradium/phonon-voices, Apache-2.0)
 * also has French, Spanish, German and Portuguese voices for it; read by Whisper they come out
 * understandable but with mistakes ("Es divino yo" for "Este dominio está"), so Aloud offers them
 * marked experimental (models.json `phonon.experimentalLanguages`).
 */

/** The languages the runtime normalises text for (numbers, dates): the `lang` it loads with. */
export type PhononLanguage = 'en' | 'fr' | 'de' | 'es' | 'pt';

const LANGUAGES: readonly PhononLanguage[] = ['en', 'fr', 'de', 'es', 'pt'];

/** `fr-FR` → `fr`; anything else (English, a character voice) → `en`. */
export function phononLanguage(tag: string): PhononLanguage {
  const code = tag.toLowerCase().split(/[-_]/)[0] as PhononLanguage;
  return LANGUAGES.includes(code) ? code : 'en';
}

/** Is `tag` one of the languages Phonon speaks with mistakes? */
export function phononExperimental(tag: string, experimental: readonly string[] | undefined): boolean {
  return (experimental ?? []).includes(tag.toLowerCase().split(/[-_]/)[0] ?? '');
}
