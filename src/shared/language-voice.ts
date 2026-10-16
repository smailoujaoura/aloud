/**
 * Picking a voice that speaks the page's language.
 *
 * A French article read by an English voice is gibberish — the words are pronounced with English
 * rules, sentence after sentence. Piper alone has voices in dozens of languages, so when the page
 * is in one of them and a voice for it is already downloaded, the reader should just use it.
 *
 * The choice is made per page and never saved: reading one French page must not quietly turn
 * someone's default voice French. Pure functions only, so the rules are testable.
 */
import type { EngineId } from '@/shared/settings';
import type { ModelManifest } from '@/engine/engines/types';

export interface CandidateVoice {
  engine: EngineId;
  id: string;
  label: string;
  /** BCP-47-ish tag: `fr-FR`, `en_GB`, `en`. */
  language: string;
}

/** `fr-FR` → `fr`, `en_GB` → `en`, `'' ` → `''`. */
export function primaryLanguage(tag: string | null | undefined): string {
  return (tag ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** `fr-FR` → `fr-fr`, `en_GB` → `en-gb`, for comparing regions. */
function fullTag(tag: string): string {
  return tag.trim().toLowerCase().replace('_', '-');
}

/**
 * The downloaded voice to read a `pageLanguage` page with, or null to keep the current one.
 *
 * Null when the page language is unknown, when the current voice already speaks it, or when
 * nothing downloaded does. Among matches: the current engine first (least surprising change of
 * sound), then the same region as the current voice, then the manifest's own order.
 */
export function pickVoiceForLanguage(
  pageLanguage: string,
  current: CandidateVoice | null,
  installed: readonly CandidateVoice[],
): CandidateVoice | null {
  const want = primaryLanguage(pageLanguage);
  if (!want) return null;
  if (current && primaryLanguage(current.language) === want) return null;

  const matches = installed.filter((v) => primaryLanguage(v.language) === want);
  if (matches.length === 0) return null;

  const score = (v: CandidateVoice): number =>
    (current && v.engine === current.engine ? 2 : 0) +
    (fullTag(v.language) === fullTag(pageLanguage) ? 1 : 0);
  return [...matches].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The voice's language, from the bundled manifest. */
export function voiceLanguage(engine: EngineId, id: string, manifest: ModelManifest): string {
  if (engine === 'piper') return manifest.piper[id]?.language ?? '';
  return manifest.kokoro.voices[id]?.language ?? 'en';
}

/** "French", "Brazilian Portuguese" — for messages. Falls back to the code itself. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag.replace('_', '-')) ?? tag;
  } catch {
    return tag;
  }
}
