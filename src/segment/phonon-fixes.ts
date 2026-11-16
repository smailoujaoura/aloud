/**
 * Words Phonon says wrong, respelled the way it says them right.
 *
 * Phonon has no pronouncing dictionary: its tokenizer cuts the written word into pieces (a 4,000-piece
 * SentencePiece vocabulary) and the model guesses the sound from the spelling, so irregular words
 * go wrong ("courtesy", "volcano", "skepticism" and "societies" were reported). Kokoro, Piper and
 * Supertonic read through a pronouncing dictionary or eSpeak and need none of this.
 *
 * Applied only when Phonon reads English, after the reader's own fixes (Settings, Pronunciation),
 * so a word they fixed themselves is never changed by this list. Each respelling is checked by ear
 * with Phonon before it goes in: a guessed one can be worse than the word.
 */
import type { EngineId } from '@/shared/settings';
import type { PronunciationRule } from './pronunciations';

/** Phonon, English: the word as written, and a spelling Phonon says right. Lowercase, whole words. */
export const PHONON_ENGLISH: readonly PronunciationRule[] = [];

/** The built-in fixes for `engine` reading `language` (a primary language code or tag). */
export function builtInFixes(engine: EngineId, language: string, list: readonly PronunciationRule[] = PHONON_ENGLISH): readonly PronunciationRule[] {
  if (engine !== 'phonon') return [];
  return (language.toLowerCase().split(/[-_]/)[0] ?? '') === 'en' ? list : [];
}
