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
interface IsTab {
  type: 'aloud-is-tab';
  tabId: number;
}

/**
 * In an Aloud page: answer when the background looks for this page.
 *
 * Every Aloud page receives every question, and the first answer is the one that counts. So a
 * page answers *only* about itself, at once, from its tab id learned at start-up — a page that
 * said "not me" a moment later could beat the one that is.
 */
export function answerTabQueries(): void {
  let mine: { id: number; windowId?: number } | null = null;
  const known = browser.tabs
    .getCurrent()
    .then((tab) => (mine = tab?.id != null ? { id: tab.id, windowId: tab.windowId } : null))
    .catch(() => null);
  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (reply: unknown) => void) => {
    const m = msg as { type?: string; path?: string; tabId?: number } | null;
    if (m?.type === 'aloud-which-tab' && m.path === location.pathname) {
      // Only pages showing that path get here, so whichever answers first is right.
      if (mine) {
        sendResponse(mine);
        return false;
      }
      return replyLater(sendResponse, known);
    }
    if (m?.type === 'aloud-is-tab' && mine && m.tabId === mine.id) {
      sendResponse(true);
      return false;
    }
    return false; // not about this page: stay silent, so the page it is about can answer
  });
}

/**
 * Is tab `tabId` one of Aloud's own pages? Its address would say, but without the "tabs"
 * permission it is hidden; the page itself answers instead. False when nothing answers.
 */
export async function isOwnTab(tabId: number): Promise<boolean> {
  try {
    return (await browser.runtime.sendMessage({ type: 'aloud-is-tab', tabId } satisfies IsTab)) === true;
  } catch {
    return false;
  }
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
