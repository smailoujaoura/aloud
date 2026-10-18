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
import { parseSupertonicVoice } from '@/shared/supertonic-voices';
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
 * nothing downloaded does. Among matches: Supertonic first, then the current engine (least
 * surprising change of sound), then the better engine — Supertonic, then Kokoro, then Piper — then the same region as
 * the page, then the manifest's own order. Supertonic first everywhere: on a processor it is two to
 * three times faster than Kokoro (on a 2018 phone, nine seconds for three seconds of speech where
 * Kokoro took a minute), it reads 31 languages, and it reads more clearly than Piper in the
 * languages the bench compared.
 */
/** Which engine reads a language better, when the current one does not speak it. */
const ENGINE_QUALITY: Partial<Record<EngineId, number>> = { supertonic: 2, kokoro: 1, piper: 0 };

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

  // Supertonic first, even before the current engine: asked for "Supertonic before Kokoro,
  // everywhere". The saved voice still reads its own language, and a voice chosen for a language
  // still wins (routeFor) — this only decides who reads a language neither covers.
  const score = (v: CandidateVoice): number =>
    (v.engine === 'supertonic' ? 1000 : 0) +
    (current && v.engine === current.engine ? 100 : 0) +
    (ENGINE_QUALITY[v.engine] ?? 0) * 10 +
    (fullTag(v.language) === fullTag(pageLanguage) ? 1 : 0);
  return [...matches].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The voice's language, from the bundled manifest. */
export function voiceLanguage(engine: EngineId, id: string, manifest: ModelManifest): string {
  if (engine === 'piper') return manifest.piper[id]?.language ?? '';
  if (engine === 'kokoro') return manifest.kokoro.voices[id]?.language ?? 'en';
  return parseSupertonicVoice(id).language; // `F1@de`: a Supertonic style reading German
}

/** "French", "Brazilian Portuguese" — for messages. Falls back to the code itself. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag.replace('_', '-')) ?? tag;
  } catch {
    return tag;
  }
}
