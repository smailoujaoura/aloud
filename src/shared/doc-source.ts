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
  // Defensive about `reopen`: a note restored from an older or hand-edited file may not have one,
  // and one unreadable record must not take the whole Notes view down with it.
  const reopen = source?.reopen;
  if (!reopen || reopen.kind === 'file') return null;
  return typeof reopen.url === 'string' ? reopen.url : null;
}

/**
 * A source that can be shown, from whatever a file provided, or null if there is nothing usable.
 *
 * Imports are the one place records arrive without Aloud having written them, and a note whose
 * source is half-missing used to be stored and then throw while the list drew it.
 */
export function normalizeSource(raw: unknown): DocSource | null {
  const source = raw as Partial<DocSource> | null;
  if (!source || typeof source !== 'object' || typeof source.key !== 'string' || !source.key) return null;
  const reopen = normalizeReopen(source.reopen, source.key);
  if (!reopen) return null;
  const title = typeof source.title === 'string' && source.title ? source.title : (sourceUrl({ ...(source as DocSource), reopen }) ?? source.key);
  const site = typeof source.site === 'string' ? source.site : siteOf(reopen.kind === 'file' ? '' : reopen.url);
  return { key: source.key, title, site, reopen };
}

function normalizeReopen(raw: unknown, key: string): Reopen | null {
  const reopen = raw as Partial<Reopen> & { url?: unknown; id?: unknown; name?: unknown };
  const url = typeof reopen?.url === 'string' ? reopen.url : null;
  if (reopen?.kind === 'file') return typeof reopen.name === 'string' ? { kind: 'file', name: reopen.name } : null;
  if (reopen?.kind === 'queue') return url && typeof reopen.id === 'string' ? { kind: 'queue', id: reopen.id, url } : null;
  if ((reopen?.kind === 'web' || reopen?.kind === 'pdf') && url) return { kind: reopen.kind, url };
  // No usable `reopen`, but the key is how Aloud names a document and is usually its address.
  return /^https?:\/\//.test(key) ? { kind: 'web', url: key } : null;
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
