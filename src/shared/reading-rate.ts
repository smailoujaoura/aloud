import type { WordTiming } from '@/engine/protocol';

/** A speed setting is a multiplier; only playing audio has a measured WPM. */
export function speedLabel(speed: number): string {
  return `${speed.toFixed(2)}×`;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const WINDOW_SECONDS = 2;

function countWords(text: string): number {
  let count = 0;
  for (const word of wordSegmenter.segment(text)) if (word.isWordLike) count++;
  return count;
}

/**
 * Speech pace at the playback position within one sentence. Word timings measure the last two
 * seconds heard, counting the fraction of a word that crosses the window's edge. Future words
 * and queued sentences contribute nothing. Without timings, use this sentence's audio duration.
 */
export function currentWpm(
  text: string,
  seconds: number,
  position: number,
  timings?: readonly WordTiming[],
): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(position)) return null;
  if (position <= 0 || position >= seconds) return 0;
  if (!timings?.length) return Math.round((countWords(text) / seconds) * 60);

  const from = Math.max(0, position - WINDOW_SECONDS);
  let words = 0;
  for (const word of timings) {
    const duration = word.end - word.start;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const overlap = Math.min(position, word.end) - Math.max(from, word.start);
    if (overlap > 0) words += (overlap / duration) * countWords(text.slice(word.from, word.to));
  }
  return Math.round((words / (position - from)) * 60);
}
