/**
 * The reader and the video speed control are separate scripts in one page, and share S D R Z X:
 * slower, faster, normal speed, back, forward. While the reader is open it takes them, and the
 * video control stands aside, so a key never does two things at once.
 *
 * An extension's content scripts share one global object per frame, so a property on it is how
 * the reader (content/session.ts) tells the video control (media-speed/controller.ts).
 */
const SLOT = '__aloudReaderKeys';

type Holder = { [SLOT]?: readonly string[] };

/** The reader's single keys while it is open in this frame; null when it closes. */
export function claimReaderKeys(keys: readonly string[] | null): void {
  (globalThis as Holder)[SLOT] = keys ?? undefined;
}

/** Is this key press one the open reader answers (the same test as its own handler)? */
export function readerOwnsKey(e: KeyboardEvent): boolean {
  const keys = (globalThis as Holder)[SLOT];
  if (!keys || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || e.key === ' ') return false;
  return keys.includes(e.key.toLowerCase());
}
