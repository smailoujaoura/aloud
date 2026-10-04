/**
 * Find a tab showing one of Aloud's own pages, without the "tabs" permission.
 *
 * Without "tabs", Chromium hides the address of every tab — Aloud's own pages included — so a
 * `tabs.query` by URL finds nothing, and "Open Library" opened another copy each time. Instead the
 * background asks; an Aloud page showing that path answers with its own tab (which a page may
 * always ask for, through `tabs.getCurrent`). No page answers: there is none open.
 */
import { browser } from 'wxt/browser';
import { replyLater } from './reply';

interface WhichTab {
  type: 'aloud-which-tab';
  path: string;
}

/** In an Aloud page: answer when the background looks for this page. */
export function answerTabQueries(): void {
  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (reply: unknown) => void) => {
    const m = msg as Partial<WhichTab> | null;
    if (m?.type !== 'aloud-which-tab' || m.path !== location.pathname) return false;
    return replyLater(
      sendResponse,
      browser.tabs.getCurrent().then((tab) => (tab ? { id: tab.id, windowId: tab.windowId } : null)),
    );
  });
}

/** In the background: the tab showing Aloud's page `path` (e.g. "/options.html"), if one is open. */
export async function findOwnTab(path: string): Promise<{ id: number; windowId?: number } | null> {
  try {
    const reply = (await browser.runtime.sendMessage({ type: 'aloud-which-tab', path } satisfies WhichTab)) as
      | { id?: number; windowId?: number }
      | null
      | undefined;
    return typeof reply?.id === 'number' ? { id: reply.id, windowId: reply.windowId } : null;
  } catch {
    return null; // no Aloud page is open to answer
  }
}
