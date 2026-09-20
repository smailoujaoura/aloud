/**
 * How fast a voice actually reads, in words a minute.
 *
 * "1.4×" says how far the slider has moved; it does not say whether that is a gentle audiobook
 * or faster than anyone can follow. Words a minute does — a podcast sits near 150, an audiobook
 * near 155, and most people top out somewhere between 300 and 450 with practice.
 *
 * The numbers below are measured, not guessed: the same 44-word passage synthesised at 1× and
 * timed (scripts/say.mjs writes the audio; its length divided by the word count is the rate).
 * Voices within an engine vary by a few per cent, which is far below what anyone can judge by
 * ear, so one figure per engine is honest enough — and the reader's own measurement replaces it
 * once there is real audio to measure.
 */
import type { EngineId } from './settings';

/** Words a minute at 1×, measured from a 44-word passage. */
export const BASE_WPM: Record<EngineId, number> = {
  piper: 187,
  kokoro: 164,
  supertonic: 150,
};

/** Words a minute for `engine` at `speed`, rounded to something worth reading. */
export function wordsPerMinute(engine: EngineId, speed: number, baseWpm = BASE_WPM[engine]): number {
  return Math.round((baseWpm * speed) / 5) * 5;
}

/** "1.4× · 260 wpm" — the label under a speed control. */
export function speedLabel(engine: EngineId, speed: number, baseWpm?: number): string {
  return `${speed.toFixed(2)}× · ${wordsPerMinute(engine, speed, baseWpm)} wpm`;
}

/**
 * The rate a voice is *really* reading at, from audio Aloud has already produced.
 *
 * Returns null until there is enough to be sure: a couple of sentences, or one long one. Short
 * sentences are dominated by their trailing silence, and a figure that jumps about as each
 * sentence lands is worse than the measured average for the engine.
 */
export function measuredWpm(words: number, seconds: number): number | null {
  if (seconds < 4 || words < 12) return null;
  return Math.round((words / seconds) * 60 / 5) * 5;
}
