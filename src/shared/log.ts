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
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
