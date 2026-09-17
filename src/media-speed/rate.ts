/**
 * Playback-rate arithmetic for the media speed control.
 *
 * Browsers accept roughly 0.06×–16×; outside a narrower band audio is muted or unintelligible,
 * so the control keeps to what is actually listenable. Steps are rounded to the step's own
 * precision: adding 0.1 to 1.2 in binary gives 1.3000000000000003, which then shows as "1.3×"
 * but compares unequal to a preset of 1.3 forever after.
 */

export const MIN_RATE = 0.25;
export const MAX_RATE = 5;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, round(rate)));
}

/** `current` moved one `step` up (+1) or down (-1). */
export function stepRate(current: number, step: number, direction: 1 | -1): number {
  return clampRate(current + step * direction);
}

/**
 * The next preset above (+1) or below (-1) `current`, stopping at the ends.
 *
 * Deliberately not a cycle: "one preset slower" wrapping round to the fastest would speed a video
 * up at the very moment someone asked for it to slow down.
 */
export function nextPreset(current: number, presets: readonly number[], direction: 1 | -1): number {
  const sorted = [...new Set(presets.map(clampRate))].sort((a, b) => a - b);
  if (sorted.length === 0) return clampRate(current);
  const now = round(current);
  const above = sorted.find((p) => p > now + 0.001);
  const below = [...sorted].reverse().find((p) => p < now - 0.001);
  if (direction === 1) return above ?? sorted[sorted.length - 1]!;
  return below ?? sorted[0]!;
}

/** "1×", "1.5×", "1.75×" — never "1.7500000001×" or a trailing zero. */
export function formatRate(rate: number): string {
  return `${round(rate)
    .toFixed(2)
    .replace(/\.?0+$/, '')}×`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
