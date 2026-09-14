/**
 * Which document something came from, and how to get back to it.
 *
 * Notes and reading history both outlive the tab they were made in, so each carries enough to
 * reopen its document: a web page by its URL, a PDF through Aloud's PDF reader, a queued article
 * through the Library. A PDF that was chosen from disk has no URL an extension may open again, so
 * it records only its name and the Library asks for the file.
 */

export type Reopen =
  | { kind: 'web'; url: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'queue'; id: string; url: string }
  | { kind: 'file'; name: string };

export interface DocSource {
  /** The document key reading positions use (`position-match.ts`), so both refer to one document. */
  key: string;
  title: string;
  /** Host name, or the file name for a local PDF. */
  site: string;
  reopen: Reopen;
}

/** The address to show and link for a source, if it has one. */
export function sourceUrl(source: DocSource): string | null {
  return source.reopen.kind === 'file' ? null : source.reopen.url;
}

/** Host name of a URL, or '' when it has none worth showing. */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol.startsWith('http') ? u.hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}
