/**
 * Marks kept on this device, per PDF.
 *
 * A PDF is identified by a hash of its bytes rather than its name or URL: the same report opened
 * from Downloads, from an email, or from the website is one document, and two different files both
 * called `report.pdf` are not. Saving marks into a file changes its bytes, so after a save the
 * marks are stored again under the new hash — that is the file that will be opened next time.
 *
 * Nothing waits on a save to the file: every change lands here straight away, so closing the tab
 * (or a browser that cannot write files at all) never loses a highlight.
 */
import { storage } from 'wxt/utils/storage';
import type { Mark } from './model';

export interface StoredMarks {
  /** The file name last seen, for a future "annotated documents" list. */
  name: string;
  marks: Mark[];
  updated: number;
}

const PREFIX = 'pdfMarks:';

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadMarks(hash: string): Promise<StoredMarks | null> {
  return (await storage.getItem<StoredMarks>(`local:${PREFIX}${hash}`)) ?? null;
}

export async function saveMarks(hash: string, name: string, marks: readonly Mark[]): Promise<void> {
  const key = `local:${PREFIX}${hash}` as const;
  // A document whose last mark was deleted leaves nothing behind — but only if it had an entry,
  // so opening a PDF and never marking it writes nothing at all.
  if (marks.length === 0) {
    if (await storage.getItem(key)) await storage.setItem<StoredMarks>(key, { name, marks: [], updated: Date.now() });
    return;
  }
  await storage.setItem<StoredMarks>(key, { name, marks: [...marks], updated: Date.now() });
}
