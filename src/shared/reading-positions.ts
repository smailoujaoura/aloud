/**
 * Where the reader stopped, per document — so a long article can be picked up again later.
 *
 * Aloud is often closed halfway through something long: the tab is needed for something else,
 * the laptop sleeps, the train arrives. Without this, reopening the page starts again from the
 * headline and the reader has to scrub around to find their place.
 *
 * The matching rules live in `position-match.ts`; this module is only the storage. Kept in
 * `storage.local`, capped to the most recent entries, and never synced: which pages a person read
 * is exactly the kind of thing that should stay on the device.
 */
import { storage } from 'wxt/utils/storage';
import { withPosition, type PositionMap, type SavedPosition } from './position-match';
import { withStorageLock } from './storage-lock';

export { documentKey, excerptOf, resumeIndex, type SavedPosition } from './position-match';

const item = storage.defineItem<PositionMap>('local:readingPositions', { fallback: {} });

export async function loadPosition(key: string): Promise<SavedPosition | undefined> {
  try {
    return (await item.getValue())[key];
  } catch {
    return undefined; // storage unavailable (some private windows) — resuming is best-effort
  }
}

export async function savePosition(key: string, pos: SavedPosition): Promise<void> {
  try {
    await withStorageLock('positions', async () => item.setValue(withPosition(await item.getValue(), key, pos)));
  } catch {
    /* best-effort */
  }
}

/** Forget a document — used when it is read to the end, so it next opens at the top. */
export async function clearPosition(key: string): Promise<void> {
  try {
    await withStorageLock('positions', async () => {
      const map = await item.getValue();
      if (!(key in map)) return;
      const { [key]: _finished, ...rest } = map;
      await item.setValue(rest);
    });
  } catch {
    /* best-effort */
  }
}

/** How many documents have a saved position, for the settings page. */
export async function countPositions(): Promise<number> {
  try {
    return Object.keys(await item.getValue()).length;
  } catch {
    return 0;
  }
}

/** Forget every document — the settings page's "clear reading positions". */
export async function clearAllPositions(): Promise<void> {
  try {
    await item.setValue({});
  } catch {
    /* best-effort */
  }
}
