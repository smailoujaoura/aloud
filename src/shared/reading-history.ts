/**
 * What has been listened to: progress, time spent, and what is left — the "Continue" list.
 *
 * Updated by the reader as it plays, a few times a minute. Kept in `storage.local` on this device,
 * capped to the most recent documents. Like reading positions, this is exactly the kind of record
 * that should never leave the machine.
 */
import { storage } from 'wxt/utils/storage';
import type { DocSource } from './doc-source';

export interface HistoryEntry {
  source: DocSource;
  /** Sentence reached, and how many there are. */
  index: number;
  total: number;
  /** Characters of spoken text before `index`, and in the whole document. */
  charsRead: number;
  charsTotal: number;
  /** Seconds of speech heard in total, across every session. */
  listenedSeconds: number;
  /** Seconds of audio per character at the speed last used, for estimating what is left. */
  secondsPerChar: number | null;
  finished: boolean;
  firstReadAt: number;
  lastReadAt: number;
}

export interface ListeningUpdate {
  source: DocSource;
  index: number;
  total: number;
  charsRead: number;
  charsTotal: number;
  /** Seconds heard since the previous update. */
  addSeconds: number;
  secondsPerChar: number | null;
  finished: boolean;
  now: number;
}

export type History = Record<string, HistoryEntry>;

export const MAX_HISTORY = 300;
/** A page opened and closed again straight away is not something to "continue". */
export const MIN_SECONDS_TO_CONTINUE = 20;
/** Speech at 1× in Piper's voices runs at about this many characters a second. */
const DEFAULT_CHARS_PER_SECOND = 14;

export function withListening(history: History, update: ListeningUpdate): History {
  const previous = history[update.source.key];
  const entry: HistoryEntry = {
    source: update.source,
    index: update.index,
    total: update.total,
    charsRead: update.charsRead,
    charsTotal: update.charsTotal,
    listenedSeconds: (previous?.listenedSeconds ?? 0) + Math.max(0, update.addSeconds),
    secondsPerChar: update.secondsPerChar ?? previous?.secondsPerChar ?? null,
    finished: update.finished,
    firstReadAt: previous?.firstReadAt ?? update.now,
    lastReadAt: update.now,
  };
  const next: History = { ...history, [update.source.key]: entry };
  const keys = Object.keys(next);
  if (keys.length <= MAX_HISTORY) return next;
  const keep = new Set(
    keys.sort((a, b) => next[b]!.lastReadAt - next[a]!.lastReadAt).slice(0, MAX_HISTORY),
  );
  return Object.fromEntries(Object.entries(next).filter(([k]) => keep.has(k)));
}

/** Fraction of the document heard, 0..1. */
export function progressOf(entry: HistoryEntry): number {
  if (entry.finished) return 1;
  if (entry.charsTotal > 0) return Math.min(1, entry.charsRead / entry.charsTotal);
  return entry.total > 0 ? Math.min(1, entry.index / entry.total) : 0;
}

/** Estimated seconds of listening left, at the speed last used. */
export function remainingSeconds(entry: HistoryEntry): number {
  if (entry.finished) return 0;
  const chars = Math.max(0, entry.charsTotal - entry.charsRead);
  return chars * (entry.secondsPerChar ?? 1 / DEFAULT_CHARS_PER_SECOND);
}

/** Unfinished documents worth picking up again, most recent first. */
export function continueList(history: History): HistoryEntry[] {
  return Object.values(history)
    .filter((e) => !e.finished && e.listenedSeconds >= MIN_SECONDS_TO_CONTINUE && e.index > 0)
    .sort((a, b) => b.lastReadAt - a.lastReadAt);
}

/** Everything, most recent first. */
export function historyList(history: History): HistoryEntry[] {
  return Object.values(history).sort((a, b) => b.lastReadAt - a.lastReadAt);
}

/** "12 min", "1 h 5 min", "under a minute". */
export function formatListeningTime(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---- storage ---------------------------------------------------------------------------------

const item = storage.defineItem<History>('local:readingHistory', { fallback: {} });

export async function loadHistory(): Promise<History> {
  try {
    return await item.getValue();
  } catch {
    return {};
  }
}

/** Updates arrive every few seconds from one reader; chain them so none overwrites another. */
let pending: Promise<void> = Promise.resolve();

export function recordListening(update: ListeningUpdate): Promise<void> {
  pending = pending
    .then(async () => item.setValue(withListening(await loadHistory(), update)))
    .catch(() => undefined);
  return pending;
}

export async function removeFromHistory(key: string): Promise<void> {
  const { [key]: _gone, ...rest } = await loadHistory();
  await item.setValue(rest);
}

export async function clearHistory(): Promise<void> {
  await item.setValue({});
}

export function watchHistory(cb: (history: History) => void): () => void {
  return item.watch((value) => cb(value ?? {}));
}
