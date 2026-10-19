/**
 * Going back to a document from the Library: "Continue", or "Listen from here" on a note.
 *
 * Both work through the saved reading position. For a note, its sentence is written as the
 * document's position first; the document is then opened the ordinary way, and the reader's own
 * resume (`maybeResume` in content/session.ts) takes it to that sentence — with the same
 * "Start over" escape hatch as any other resume.
 */
import { browser } from 'wxt/browser';
import type { DocSource } from '@/shared/doc-source';
import type { NotePosition } from '@/shared/notes';
import { savePosition } from '@/shared/reading-positions';
import { toast } from './feedback';
import { inQueue, play } from './queue-panel';

export async function reopen(source: DocSource, at: NotePosition | null, showQueue: () => void): Promise<void> {
  const { reopen: how } = source;
  // Starting the reader in a tab Aloud opens itself needs permission for that site — the
  // toolbar-button permission only comes from a click on that page. It has to be *requested*
  // inside this click, before anything is awaited.
  // A PDF needs none: it opens in Aloud's own PDF page, which asks for a site itself if it must.
  const origin = how.kind === 'web' || how.kind === 'queue' ? originPattern(how.url) : null;
  const permission =
    origin && !(how.kind === 'queue' && inQueue(how.id)) ? browser.permissions.request({ origins: [origin] }).catch(() => false) : null;

  const position = at ? { ...at, savedAt: Date.now() } : null;
  if (position) await savePosition(source.key, position);

  if (how.kind === 'queue' && inQueue(how.id)) {
    showQueue();
    await play(how.id, position);
    return;
  }
  if (how.kind === 'file') {
    await browser.tabs.create({ url: browser.runtime.getURL('/pdf.html') });
    toast(`Choose ${how.name} again. Browsers don’t let Aloud reopen files from your disk`);
    return;
  }
  if (how.kind === 'pdf' || (await permission)) {
    // The browser will still want a click on ▶ before audio plays in the new tab.
    // The position goes along too: a reader already open in that tab overwrites the stored one
    // as it closes.
    await browser.runtime.sendMessage({ type: 'open-and-read', url: how.url, at: position });
    return;
  }
  // Without that site's permission Aloud cannot see which tabs show it (it has no "tabs"
  // permission, by design), so it cannot pick out an open one: a new tab, resuming from storage.
  await browser.tabs.create({ url: how.url });
  toast('Press the Aloud button on that page to pick up where you were');
}

function originPattern(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? `${protocol}//${hostname}/*` : null;
  } catch {
    return null;
  }
}
