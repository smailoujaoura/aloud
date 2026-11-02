/**
 * Phonon's voices: what they speak, and which languages are experimental.
 *
 * Phonon S (31M) was trained on English. Gradium's catalogue (gradium/phonon-voices, Apache-2.0)
 * also has French, Spanish, German and Portuguese voices for it; read by Whisper they come out
 * understandable but with mistakes ("Es divino yo" for "Este dominio está"), so Aloud offers them
 * marked experimental (models.json `phonon.experimentalLanguages`), unless the reader downloads
 * Gradium's 40m multilingual model, which reads them well (Whisper, 2026-11-02: near word for word
 * in all four, where the 31M said "Le gardien du fer … à la 2 mai de la nuit").
 */

import type { ModelManifest, PhononPack } from '@/engine/engines/types';

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

/** The addresses of a Phonon pack's three files, as the model cache keys them. */
export function phononPackUrls(pack: Pick<PhononPack, 'base' | 'files'>): { weights: string; tokenizer: string; config: string } {
  return { weights: `${pack.base}/${pack.files.weights}`, tokenizer: `${pack.base}/${pack.files.tokenizer}`, config: `${pack.base}/${pack.files.config}` };
}

/** Is Phonon's multilingual model on this device (all three files, with something in them)? */
export function phononPackInstalled(manifest: Pick<ModelManifest, 'phonon'>, sizes: ReadonlyMap<string, number>): boolean {
  const pack = manifest.phonon?.multilingual;
  if (!pack) return false;
  return Object.values(phononPackUrls(pack)).every((url) => (sizes.get(url) ?? 0) > 0);
}

/**
 * The catalogue as this device reads it: with Phonon's multilingual model here, the languages it
 * reads are no longer experimental (in the lists, on the board, in choosing who reads a passage).
 */
export function withPhononPack<M extends Pick<ModelManifest, 'phonon'>>(manifest: M, sizes: ReadonlyMap<string, number>): M {
  const phonon = manifest.phonon;
  if (!phonon?.multilingual || !phononPackInstalled(manifest, sizes)) return manifest;
  const read = new Set(phonon.multilingual.languages);
  return { ...manifest, phonon: { ...phonon, experimentalLanguages: phonon.experimentalLanguages.filter((l) => !read.has(l)) } };
}
