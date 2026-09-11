/**
 * Handing a PDF's bytes from the background to the reader page.
 *
 * Not through `runtime.sendMessage`: **Chromium serialises extension messages as JSON**, so an
 * `ArrayBuffer` arrives as `{}` and pdf.js reports "The PDF file is empty, i.e. its size is zero
 * bytes" — which is exactly what the first version of this hand-off did. Base64 would work but
 * would copy a 40 MB report twice, through a string.
 *
 * IndexedDB is shared by every same-origin extension context, stores binary as binary, and
 * survives the service worker being evicted between opening the tab and the page asking for its
 * file. The background writes one record, the page reads it once and deletes it, and anything
 * left behind by a tab that was closed too early is swept on the next hand-off.
 */

const DB_NAME = 'aloud-pdf-handoff';
const STORE = 'files';
const DB_VERSION = 1;

/** Records older than this are debris from a reader tab that never collected them. */
const TTL_MS = 10 * 60_000;

export interface PdfHandoff {
  data: ArrayBuffer;
  /** File name for the UI ("call-for-applications.pdf"). */
  name: string;
  /** Where it came from, so the page can explain itself and offer the picker. */
  url: string;
  at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the PDF hand-off database'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const req = run(transaction.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('PDF hand-off failed'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

/** Store a fetched PDF for the reader page to collect. Returns the job id. */
export async function putPdf(id: string, handoff: Omit<PdfHandoff, 'at'>): Promise<void> {
  await tx('readwrite', (store) => store.put({ ...handoff, at: Date.now() } satisfies PdfHandoff, id));
}

/** Collect a PDF exactly once. Returns `null` when the id is unknown or already collected. */
export async function takePdf(id: string): Promise<PdfHandoff | null> {
  const record = (await tx('readonly', (store) => store.get(id))) as PdfHandoff | undefined;
  if (!record) return null;
  await tx('readwrite', (store) => store.delete(id)).catch(() => undefined);
  return record;
}

/** Drop records no reader page ever collected. Best-effort: never let cleanup break a hand-off. */
export async function sweepPdfHandoffs(): Promise<void> {
  try {
    const keys = (await tx('readonly', (store) => store.getAllKeys())) as IDBValidKey[];
    const records = (await tx('readonly', (store) => store.getAll())) as PdfHandoff[];
    const cutoff = Date.now() - TTL_MS;
    await Promise.all(
      keys
        .filter((_, i) => (records[i]?.at ?? 0) < cutoff)
        .map((key) => tx('readwrite', (store) => store.delete(key))),
    );
  } catch {
    /* the store may not exist yet */
  }
}
