/**
 * Tiny logging helper. Every log line is prefixed so it is easy to filter the extension's
 * output out of a noisy page console (`aloud` in the console filter box).
 */
const PREFIX = '[aloud]';

type Level = 'debug' | 'info' | 'warn' | 'error';

let enabled = true;

export function setLogging(on: boolean): void {
  enabled = on;
}

function emit(level: Level, args: unknown[]): void {
  if (!enabled && level === 'debug') return;
  // eslint-disable-next-line no-console
  console[level](PREFIX, ...args);
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warn: (...a: unknown[]) => emit('warn', a),
  error: (...a: unknown[]) => emit('error', a),
};

/** Format bytes for progress UIs. */
/**
 * Bytes in the units the browser and the system show: 1 MB is 1,000,000 bytes. Counting in 1024s
 * put the same file at 310 MB here and 325 MB in Firefox's own download panel.
 */
export function humanBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
