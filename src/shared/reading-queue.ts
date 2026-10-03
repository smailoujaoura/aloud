/**
 * The reading queue: articles saved to be read aloud one after another.
 *
 * An article is *extracted when it is added* — the page is open and readable right then — so the
 * queue page can play it later offline, without the site, and without having to navigate a tab
 * (after a navigation a browser will not start audio until the new page is clicked again, which
 * would stop a queue at every article). A link added from a context menu has no article yet; the
 * queue page downloads it when its turn comes.
 *
 * Kept in `storage.local` (the extension has `unlimitedStorage`), on this device only.
 */
import { storage } from 'wxt/utils/storage';
import { documentKey } from './position-match';
import { withStorageLock } from './storage-lock';

export interface QueuedArticle {
  /** Readability's cleaned HTML; empty when it could only find plain text. */
  html: string;
  text: string;
  lang: string;
  byline: string | null;
}

export interface QueueItem {
  id: string;
  url: string;
  title: string;
  site: string;
  addedAt: number;
  /** Present when added from an open page; absent for a link that has not been downloaded yet. */
  article?: QueuedArticle;
}

export type NewQueueItem = Omit<QueueItem, 'id' | 'addedAt'>;

/** A reading list, not an archive: past this, adding is refused with a message. */
export const MAX_QUEUE = 100;

// ---- pure helpers (unit-tested) -------------------------------------------

/**
 * Add `item`, unless the same document is already queued — in which case an entry without an
 * article is *upgraded* with the new one (a link queued earlier, then added again from its page).
 */
export function withItemAdded(
  queue: readonly QueueItem[],
  item: QueueItem,
  max = MAX_QUEUE,
): { queue: QueueItem[]; added: boolean; full: boolean } {
  const key = documentKey(item.url);
  const existing = queue.findIndex((q) => documentKey(q.url) === key);
  if (existing >= 0) {
    const next = [...queue];
    const current = next[existing]!;
    if (!current.article && item.article) next[existing] = { ...current, article: item.article, title: item.title || current.title };
    return { queue: next, added: false, full: false };
  }
  if (queue.length >= max) return { queue: [...queue], added: false, full: true };
  return { queue: [...queue, item], added: true, full: false };
}

export function withItemMoved(queue: readonly QueueItem[], id: string, delta: number): QueueItem[] {
  const from = queue.findIndex((q) => q.id === id);
  if (from < 0) return [...queue];
  const to = Math.max(0, Math.min(queue.length - 1, from + delta));
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function withItemRemoved(queue: readonly QueueItem[], id: string): QueueItem[] {
  return queue.filter((q) => q.id !== id);
}

// ---- storage ---------------------------------------------------------------

const LOCK_KEY = 'queue';
const item = storage.defineItem<QueueItem[]>('local:readingQueue', { fallback: [] });

export async function loadQueue(): Promise<QueueItem[]> {
  try {
    return await item.getValue();
  } catch {
    return [];
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function addToQueue(entry: NewQueueItem): Promise<{ added: boolean; full: boolean; size: number }> {
  return withStorageLock(LOCK_KEY, async () => {
    const result = withItemAdded(await loadQueue(), { ...entry, id: newId(), addedAt: Date.now() });
    await item.setValue(result.queue);
    return { added: result.added, full: result.full, size: result.queue.length };
  });
}

export async function removeFromQueue(id: string): Promise<QueueItem[]> {
  return withStorageLock(LOCK_KEY, async () => {
    const next = withItemRemoved(await loadQueue(), id);
    await item.setValue(next);
    return next;
  });
}

export async function moveInQueue(id: string, delta: number): Promise<QueueItem[]> {
  // Under the lock like every other write: a reorder that read the queue before an article was
  // added, and wrote it back after, erased that article while both reported success.
  return withStorageLock(LOCK_KEY, async () => {
    const next = withItemMoved(await loadQueue(), id, delta);
    await item.setValue(next);
    return next;
  });
}

export async function updateQueueItem(id: string, patch: Partial<Omit<QueueItem, 'id'>>): Promise<void> {
  await withStorageLock(LOCK_KEY, async () => {
    const queue = await loadQueue();
    await item.setValue(queue.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  });
}

export async function clearQueue(): Promise<void> {
  await withStorageLock(LOCK_KEY, () => item.setValue([]));
}

export function watchQueue(cb: (queue: QueueItem[]) => void): () => void {
  return item.watch((value) => cb(value ?? []));
}
