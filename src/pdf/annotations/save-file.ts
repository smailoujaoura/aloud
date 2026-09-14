/**
 * Writing the annotated PDF somewhere the user will find it — ideally over the file they opened.
 *
 * What each browser allows:
 *
 *  - **Chromium, file chosen through Aloud's picker (or dropped in):** the File System Access API
 *    hands over a handle to that very file. Saving writes straight back into it, after Chromium's
 *    one-time "let this page save changes to report.pdf?" prompt.
 *  - **Chromium, file opened any other way** (the toolbar button on a PDF tab, a link): there is
 *    no handle, so "Save" opens the system save dialog with the file's name filled in. Pointing it
 *    at the original replaces it; the handle is then kept, so later saves go straight there.
 *  - **Firefox:** no File System Access API at all. The downloads API can still show a real
 *    "Save as" dialog with the name filled in — choosing the original file replaces it. It needs
 *    the `downloads` permission, asked for on the first save. Without it (or on Android, which has
 *    no dialog) the file goes to the downloads folder as a copy.
 */
import { browser } from 'wxt/browser';

/** The File System Access API, which TypeScript's DOM library does not describe yet. */
interface WritableHandle {
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
}

interface PickerWindow {
  showOpenFilePicker?(o: unknown): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o: unknown): Promise<FileSystemFileHandle>;
}

const PDF_TYPES = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];

export type SaveResult =
  | { kind: 'written'; name: string; handle: FileSystemFileHandle }
  | { kind: 'downloaded'; name: string; askedWhere: boolean }
  | { kind: 'cancelled' };

/** What "Save" will do here, for the button's label and tooltip. */
export type SaveMode = 'in-place' | 'save-as' | 'download-as' | 'download';

export function saveMode(handle: FileSystemFileHandle | null): SaveMode {
  if (handle) return 'in-place';
  if ((window as PickerWindow).showSaveFilePicker) return 'save-as';
  return browser.downloads || browser.permissions ? 'download-as' : 'download';
}

/** Whether the browser can hand over a writable handle when a PDF is opened. */
export function canOpenWithHandle(): boolean {
  return typeof (window as PickerWindow).showOpenFilePicker === 'function';
}

/** The system file picker, returning the file and a handle that can be written back to. */
export async function pickPdfWithHandle(): Promise<{ file: File; handle: FileSystemFileHandle } | null> {
  try {
    const [handle] = await (window as PickerWindow).showOpenFilePicker!({ types: PDF_TYPES, multiple: false });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/**
 * Save `build()`'s bytes. Everything that needs the click's user activation (a permission
 * prompt, a file dialog) happens *before* `build()` runs, since building a large PDF can take
 * longer than the browser keeps that activation alive.
 */
export async function saveFile(
  name: string,
  handle: FileSystemFileHandle | null,
  build: () => Promise<Uint8Array>,
): Promise<SaveResult> {
  if (handle) {
    const writable = handle as unknown as WritableHandle;
    const state =
      (await writable.queryPermission?.({ mode: 'readwrite' })) === 'granted'
        ? 'granted'
        : await writable.requestPermission?.({ mode: 'readwrite' });
    if (state && state !== 'granted') return { kind: 'cancelled' };
    await write(writable, await build());
    return { kind: 'written', name: handle.name, handle };
  }

  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    let target: FileSystemFileHandle;
    try {
      target = await picker({ suggestedName: name, types: PDF_TYPES });
    } catch (err) {
      if (isAbort(err)) return { kind: 'cancelled' };
      throw err;
    }
    await write(target as unknown as WritableHandle, await build());
    return { kind: 'written', name: target.name, handle: target };
  }

  // Firefox. The permission request must be *called* inside the click, so it starts first.
  const permission = requestDownloads();
  const bytes = await build();
  if (await permission) {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    try {
      await browser.downloads.download({ url, filename: name, saveAs: true, conflictAction: 'uniquify' });
      return { kind: 'downloaded', name, askedWhere: true };
    } catch (err) {
      // Closing the dialog rejects with "Download canceled"; anything else falls through to a copy.
      if (/cancel/i.test(String(err instanceof Error ? err.message : err))) return { kind: 'cancelled' };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
  downloadWithLink(name, bytes);
  return { kind: 'downloaded', name, askedWhere: false };
}

function requestDownloads(): Promise<boolean> {
  try {
    if (!browser.permissions?.request) return Promise.resolve(false);
    return browser.permissions.request({ permissions: ['downloads'] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

async function write(handle: WritableHandle, bytes: Uint8Array): Promise<void> {
  const stream = await handle.createWritable();
  await stream.write(bytes as Uint8Array<ArrayBuffer>);
  await stream.close();
}

function downloadWithLink(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
