/**
 * Which voice reads a passage in a given language — and why, so the reader can be told.
 *
 * In order:
 *  - Manual: the reader locked this page to one voice. Detection never undoes that.
 *  - Auto off (the "match the language" setting): the saved voice, as before languages existed.
 *  - The voice chosen for that language (settings: `languageVoices`), when it is downloaded.
 *  - The saved voice, when it speaks the language.
 *  - Another downloaded voice that speaks it (`pickVoiceForLanguage`'s order).
 *  - None downloaded: skipped, if the reader said so for this language; otherwise read in
 *    English — the voice English would get — and *marked missing*, so the bar can say so and
 *    offer a download, never passing it off as the right voice. English, not the saved voice:
 *    with an Italian voice saved, a French passage came out in Italian, which helps nobody; and
 *    with no English voice either, the saved voice.
 *
 * Pure; the session supplies what is downloaded.
 */
import type { VoiceRef } from '@/shared/settings';
import { pickVoiceForLanguage, primaryLanguage, type CandidateVoice } from '@/shared/language-voice';

export type RouteReason = 'manual' | 'off' | 'unknown' | 'preference' | 'saved' | 'match' | 'missing' | 'other';

export type Route =
  | { kind: 'voice'; voice: CandidateVoice; reason: RouteReason; language: string }
  | { kind: 'skip'; language: string };

export interface RouteContext {
  /** Auto is on in settings. */
  auto: boolean;
  /** The voice this page is locked to, or null in Auto. */
  manual: CandidateVoice | null;
  /** The saved voice. */
  saved: CandidateVoice;
  preferences: Readonly<Record<string, VoiceRef>>;
  installed: readonly CandidateVoice[];
  /** Languages with no voice the reader chose to skip on this page. */
  skip: ReadonlySet<string>;
  /**
   * Voices put away in Settings (`engine:voice`). Auto passes over them while a voice still in
   * view speaks the language; one chosen for the language, or the saved voice, is used anyway.
   */
  hidden?: ReadonlySet<string>;
  /** A language no downloaded voice speaks: read in English (default), or skipped. */
  unvoiced?: 'english' | 'skip';
  /** Languages taken off the board: read like every other language, by choice — not "missing". */
  removed?: ReadonlySet<string>;
  /** The voice chosen for every other language; absent for the voice English gets. */
  other?: VoiceRef | null;
  /**
   * Reading runs on a GPU (true), or not / not known yet: which engine Auto prefers when the saved
   * voice does not speak a language (pickVoiceForLanguage). Without one, Supertonic before Kokoro.
   */
  gpu?: boolean | null;
}

export function voiceKey(v: { engine: string; id?: string; voice?: string }): string {
  return `${v.engine}:${v.id ?? v.voice}`;
}

export function routeFor(languageTag: string, ctx: RouteContext): Route {
  const language = primaryLanguage(languageTag);
  if (ctx.manual) return { kind: 'voice', voice: ctx.manual, reason: 'manual', language };
  if (!ctx.auto) return { kind: 'voice', voice: ctx.saved, reason: 'off', language };
  if (!language) return { kind: 'voice', voice: ctx.saved, reason: 'unknown', language };

  // Taken off the board: read like every other language, and not reported as a missing voice.
  if (ctx.removed?.has(language)) {
    if (ctx.unvoiced === 'skip') return { kind: 'skip', language };
    return { kind: 'voice', voice: fallbackVoice(ctx), reason: 'other', language };
  }
  const preferred = ctx.preferences[language];
  if (preferred) {
    const found = ctx.installed.find((v) => v.engine === preferred.engine && v.id === preferred.voice);
    if (found) return { kind: 'voice', voice: found, reason: 'preference', language };
  }
  if (primaryLanguage(ctx.saved.language) === language) return { kind: 'voice', voice: ctx.saved, reason: 'saved', language };
  const hidden = ctx.hidden;
  const visible = hidden?.size ? ctx.installed.filter((v) => !hidden.has(voiceKey(v))) : ctx.installed;
  const match = pickVoiceForLanguage(language, ctx.saved, visible, ctx.gpu) ?? pickVoiceForLanguage(language, ctx.saved, ctx.installed, ctx.gpu);
  if (match) return { kind: 'voice', voice: match, reason: 'match', language };
  if (ctx.skip.has(language) || (ctx.unvoiced === 'skip' && language !== 'en')) return { kind: 'skip', language };
  // English itself missing: the saved voice (asking for the English fallback here would loop).
  return { kind: 'voice', voice: language === 'en' ? ctx.saved : fallbackVoice(ctx), reason: 'missing', language };
}

/** Who reads a language no downloaded voice speaks: the voice English gets, else the saved one. */
export function fallbackVoice(ctx: RouteContext): CandidateVoice {
  const chosen = ctx.other ? ctx.installed.find((v) => v.engine === ctx.other!.engine && v.id === ctx.other!.voice) : undefined;
  if (chosen) return chosen;
  const english = routeFor('en', { ...ctx, skip: new Set(), removed: new Set() });
  return english.kind === 'voice' && english.reason !== 'missing' ? english.voice : ctx.saved;
}
