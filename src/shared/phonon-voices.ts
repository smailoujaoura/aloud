/**
 * Phonon's voices: what they speak, and which languages are experimental.
 *
 * Phonon is Gradium's 40m multilingual model, which reads English, French, German, Spanish and
 * Portuguese near word for word (Whisper, 2026-11-03). Phonon 31M, used before it, read only
 * English well ("Le gardien du fer … à la 2 mai de la nuit"), and its other voices were marked
 * experimental (models.json `phonon.experimentalLanguages`, now empty; the marking stays for a
 * model that reads some language less well).
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
