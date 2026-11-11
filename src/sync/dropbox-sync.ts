/**
 * Notes and PDF marks synced through the reader's Dropbox: the connection, this device's side of
 * the data, and a round of sync as the background and the settings page run it.
 */
import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import { loadNotes, rewriteNotes } from '@/shared/notes';
import { loadPositions, rewritePositions } from '@/shared/reading-positions';
import { normalizeStoredMarks } from '@/shared/record-shapes';
import { withStorageLock } from '@/shared/storage-lock';
import { reconcileById, reconcileMaps } from '@/shared/three-way';
import { loadMarks, saveMarks } from '@/pdf/annotations/store';
import type { Mark } from '@/pdf/annotations/model';
import { DropboxClient, DropboxError, DropboxFile, exchangeCode, type AuthStore, type DropboxAuth } from './dropbox';
import { contentOf, emptyDoc, forgetCloudSync, runCloudSync, setCloudError, type LocalData, type SyncDoc } from './cloud-sync';

/** In Apps/Aloud-tts, the only folder the app can see. */
export const SYNC_PATH = '/aloud.json';

/**
 * What Firefox asks the reader to agree to sending: notes are passages of web pages (website
 * content) with the address of each page (browsing activity).
 */
export const SYNC_DATA_CONSENT = ['websiteContent', 'browsingActivity'];

const authItem = storage.defineItem<DropboxAuth | null>('local:dropboxAuth', { fallback: null });
/** A sign-in begun on a phone, waiting for the code Dropbox shows. */
const pendingItem = storage.defineItem<{ verifier: string; at: number } | null>('local:dropboxPending', { fallback: null });

export const dropboxAuth: AuthStore = {
  get: () => authItem.getValue(),
  set: (auth) => authItem.setValue(auth),
};

export function watchDropboxAuth(cb: (auth: DropboxAuth | null, before: DropboxAuth | null) => void): () => void {
  return authItem.watch((value, old) => cb(value ?? null, old ?? null));
}

const PDF_MARKS = 'pdfMarks:';
const newestFirst = (a: { createdAt: number }, b: { createdAt: number }): number => b.createdAt - a.createdAt;

/** This device's notes and marks, read and written under the same locks as every other writer. */
export const localData: LocalData = {
  async read(): Promise<SyncDoc> {
    const doc = emptyDoc();
    doc.notes = await loadNotes();
    doc.positions = await loadPositions();
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(PDF_MARKS)) continue;
      const stored = normalizeStoredMarks(value);
      if (stored && stored.marks.length > 0) doc.pdfMarks[key.slice(PDF_MARKS.length)] = { name: stored.name, marks: stored.marks as Mark[] };
    }
    return doc;
  },

  async write(merged: SyncDoc, seen: SyncDoc): Promise<void> {
    await rewriteNotes((now) => reconcileById(merged.notes, seen.notes, now, (n) => n.updatedAt ?? 0).sort(newestFirst));
    await rewritePositions((now) => reconcileMaps(merged.positions, seen.positions, now, (p) => p.savedAt));
    const hashes = new Set([...Object.keys(merged.pdfMarks), ...Object.keys(seen.pdfMarks)]);
    for (const hash of hashes) {
      await withStorageLock(`${PDF_MARKS}${hash}`, async () => {
        const stored = await loadMarks(hash);
        const now = (stored?.marks ?? []) as Mark[];
        const result = reconcileById(merged.pdfMarks[hash]?.marks ?? [], seen.pdfMarks[hash]?.marks ?? [], now, (m) => m.updated ?? 0);
        const same = (marks: Mark[]) => contentOf({ ...emptyDoc(), pdfMarks: { [hash]: { name: '', marks } } });
        if (same(result) === same(now)) return;
        // An open PDF folds this in as it does another tab's change (pdf/annotations/sync.ts).
        await saveMarks(hash, stored?.name || merged.pdfMarks[hash]?.name || '', result);
      });
    }
  },
};

async function consented(): Promise<boolean> {
  if (import.meta.env.BROWSER !== 'firefox') return true;
  try {
    return await browser.permissions.contains({ data_collection: SYNC_DATA_CONSENT } as never);
  } catch {
    return true; // a Firefox without data-collection permissions has nothing to ask
  }
}

/** What went wrong, in words for the Sync section. */
export function describeSyncError(err: unknown): string {
  if (err instanceof DropboxError) {
    if (err.status === 401 || /invalid_grant|expired_access_token|invalid_access_token/.test(err.summary))
      return 'Dropbox no longer lets Aloud in (its access was taken back). Disconnect, then connect again.';
    if (err.status === 429) return 'Dropbox asked Aloud to slow down. It will try again shortly.';
    if (/insufficient_space/.test(err.summary)) return 'Your Dropbox is full, so your notes could not be saved there.';
    if (err.status >= 500) return 'Dropbox is not answering just now. Aloud will try again shortly.';
    return `Dropbox said: ${err.summary}`;
  }
  if (err instanceof TypeError) return 'Dropbox could not be reached. Aloud will try again when you are online.';
  return err instanceof Error ? err.message : String(err);
}

/** One round of sync, when connected. Problems are kept for the Sync section, never thrown. */
export async function syncWithDropbox(reason: 'here' | 'other'): Promise<void> {
  if (!(await authItem.getValue())) return;
  if (!(await consented())) {
    await setCloudError("Firefox's permission to send your notes to Dropbox was taken back. Disconnect, then connect again.");
    return;
  }
  const file = new DropboxFile(new DropboxClient(dropboxAuth, (url, init) => fetch(url, init)), SYNC_PATH);
  try {
    await runCloudSync(file, localData, reason);
  } catch (err) {
    await setCloudError(describeSyncError(err));
  }
}

/** The code Dropbox gave (or showed): connected, and who to. */
export async function connectDropbox(code: string, verifier: string, redirectUri: string | undefined): Promise<void> {
  const auth = await exchangeCode(code, verifier, redirectUri, (url, init) => fetch(url, init));
  // A new connection keeps both sides: what this device has and what the file has.
  await forgetCloudSync();
  await pendingItem.setValue(null);
  let who = '';
  try {
    who = await new DropboxClient({ get: async () => auth, set: async () => undefined }, (url, init) => fetch(url, init)).who();
  } catch {
    /* shown without a name */
  }
  await authItem.setValue({ ...auth, ...(who ? { who } : {}) });
}

/** Stop syncing. Notes stay on this device and in the reader's Dropbox. */
export async function disconnectDropbox(): Promise<void> {
  if (await authItem.getValue()) await new DropboxClient(dropboxAuth, (url, init) => fetch(url, init)).revoke();
  await authItem.setValue(null);
  await forgetCloudSync();
}

export async function setPendingSignIn(verifier: string): Promise<void> {
  await pendingItem.setValue({ verifier, at: Date.now() });
}

/** The verifier of a sign-in begun on this device in the last hour. */
export async function pendingSignIn(): Promise<string | null> {
  const pending = await pendingItem.getValue();
  return pending && Date.now() - pending.at < 60 * 60 * 1000 ? pending.verifier : null;
}
