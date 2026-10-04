/**
 * `for await (const chunk of readableStream)`, where the browser cannot do it yet.
 *
 * pdf.js reads a page's text that way. Chromium added async iteration of streams after 120, the
 * oldest version Aloud supports, and there every PDF failed to open with "e is not async
 * iterable". This adds the standard behaviour — read until done, release the reader — only when
 * it is missing, and changes nothing where it exists.
 */
export function ensureStreamIteration(): void {
  const proto = (globalThis as { ReadableStream?: { prototype: object } }).ReadableStream?.prototype as
    | (ReadableStream & { [Symbol.asyncIterator]?: unknown; values?: unknown })
    | undefined;
  if (!proto || typeof proto[Symbol.asyncIterator] === 'function') return;
  async function* values(this: ReadableStream, options?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      // Left early (a `break`, a throw): cancel the stream, as the standard does by default.
      if (!finished && !options?.preventCancel) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  Object.defineProperty(proto, 'values', { value: values, writable: true, configurable: true });
  Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}
