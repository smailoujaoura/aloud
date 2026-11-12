/**
 * Where the reader stopped, per document — so a long article can be picked up again later.
 *
 * Aloud is often closed halfway through something long: the tab is needed for something else,
 * the laptop sleeps, the train arrives. Without this, reopening the page starts again from the
 * headline and the reader has to scrub around to find their place.
 *
 * The matching rules live in `position-match.ts`; this module is only the storage. Kept in
 * `storage.local`, capped to the most recent entries. Which pages a person read is exactly the kind
 * of thing that should stay on the device, so they leave it only when the reader connects their own
 * Dropbox (sync/cloud-sync.ts), to reach their other devices; never the browser's sync.
 */
import { storage } from 'wxt/utils/storage';
import { withPosition, type PositionMap, type SavedPosition } from './position-match';
import { withStorageLock } from './storage-lock';
import { normalizePosition, recordsOf } from './record-shapes';

export { documentKey, excerptOf, formerDocumentKey, resumeIndex, type SavedPosition } from './position-match';

const item = storage.defineItem<PositionMap>('local:readingPositions', { fallback: {} });

/** The stored map, with any damaged entry dropped (shared/record-shapes.ts). */
const readMap = async (): Promise<PositionMap> => recordsOf(await item.getValue(), normalizePosition);

export async function loadPosition(key: string): Promise<SavedPosition | undefined> {
  try {
    return (await readMap())[key];
  } catch {
    return undefined; // storage unavailable (some private windows) — resuming is best-effort
  }
}

export async function savePosition(key: string, pos: SavedPosition): Promise<void> {
  try {
    await withStorageLock('positions', async () => item.setValue(withPosition(await readMap(), key, pos)));
  } catch {
    /* best-effort */
  }
}

/** Forget a document — used when it is read to the end, so it next opens at the top. */
export async function clearPosition(key: string): Promise<void> {
  try {
    await withStorageLock('positions', async () => {
      const map = await readMap();
      if (!(key in map)) return;
      const { [key]: _finished, ...rest } = map;
      await item.setValue(rest);
    });
  } catch {
    /* best-effort */
  }
}

/** Follow one document's saved position: another tab's, or another device's arriving through sync. */
export function watchPosition(key: string, cb: (pos: SavedPosition | undefined) => void): () => void {
  return item.watch((map) => cb(normalizePosition(map?.[key]) ?? undefined));
}

/** Every saved position, by document. */
export async function loadPositions(): Promise<PositionMap> {
  try {
    return await readMap();
  } catch {
    return {};
  }
}

/** Replace the positions with `change(positions)`, under their lock (sync from another device). */
export async function rewritePositions(change: (positions: PositionMap) => PositionMap): Promise<void> {
  await withStorageLock('positions', async () => {
    const before = await readMap();
    const after = change(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) await item.setValue(after);
  });
}

/** How many documents have a saved position, for the settings page. */
export async function countPositions(): Promise<number> {
  try {
    return Object.keys(await readMap()).length;
  } catch {
    return 0;
  }
}

/** Forget every document — the settings page's "clear reading positions". */
export async function clearAllPositions(): Promise<void> {
  try {
    await withStorageLock('positions', () => item.setValue({}));
  } catch {
    /* best-effort */
  }
}
