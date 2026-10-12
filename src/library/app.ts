/**
 * The Library's views on Aloud's page: what to continue, what is up next, the notes kept along
 * the way, history, and statistics.
 *
 * Everything here lives in `storage.local` on this device (see `shared/notes.ts`,
 * `shared/reading-history.ts`, `shared/reading-queue.ts`) and updates live as the reader writes
 * to it from other tabs.
 */
import { initNotes } from './notes-panel';
import { initQueue } from './queue-panel';
import { initReading } from './reading-panels';
import { initStats } from './stats-panel';
import { reopen } from './reopen';

export interface LibraryHost {
  /** Show one of the Library's views. */
  show(view: 'continue' | 'queue' | 'notes' | 'history'): void;
  /** The count badge beside a view in the navigation. */
  setCount(view: 'continue' | 'queue' | 'notes', n: number): void;
}

/** Wire the Library's views. Resolves with how many documents are waiting to be continued. */
export async function initLibrary(host: LibraryHost): Promise<{ continueCount: number }> {
  const showQueue = (): void => host.show('queue');
  let continueCount = 0;
  await Promise.all([
    initQueue({ onCount: (n) => host.setCount('queue', n) }),
    initNotes({
      onCount: (n) => host.setCount('notes', n),
      onListen: (note) => void reopen(note.source, note.at, showQueue),
    }),
    initReading({
      onContinueCount: (n) => {
        continueCount = n;
        host.setCount('continue', n);
      },
      onContinue: (entry) => void reopen(entry.source, null, showQueue),
    }),
    initStats(),
  ]);
  return { continueCount };
}
