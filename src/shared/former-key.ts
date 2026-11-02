/**
 * A document known by another key before: its saved place and its history move to the new key.
 *
 * PDFs were known by file name and page count (`pdf:report.pdf:12`), so two different files with
 * the same name shared one place and one history entry. They are now known by their text
 * (pdf/main.ts), and what was saved under the old key is taken over only when it is this
 * document's: the saved sentence must be in it, or, for history alone (a document
 * read to the end keeps no place), the title must be the same.
 */
import { renameHistoryEntry } from './reading-history';
import { clearPosition, excerptOf, loadPosition, savePosition } from './reading-positions';

/** A PDF's key: `pdf:text:` and the first 128 bits of the SHA-256 of its text. */
export async function pdfTextKey(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return `pdf:text:${[...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function adoptFormerKey(former: string, key: string, sentences: readonly string[], title: string): Promise<void> {
  if (!former || !key || former === key) return;
  try {
    const [here, before] = await Promise.all([loadPosition(key), loadPosition(former)]);
    const ours = !here && before !== undefined && sentences.some((s) => excerptOf(s) === before.excerpt);
    if (ours) {
      await savePosition(key, before);
      await clearPosition(former);
    }
    await renameHistoryEntry(former, key, (entry) => ours || entry.source.title === title);
  } catch {
    /* best-effort, like the records themselves */
  }
}
