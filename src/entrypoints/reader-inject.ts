/**
 * Content script — injected on demand with `scripting.executeScript` (activeTab) when the user
 * activates the extension on a tab. Never declared in the manifest, so the extension asks for
 * no broad host permissions. Idempotent: re-injection is a no-op — the follow-up `activate`
 * message from the background carries the real mode.
 */
import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { ReaderSession } from '@/content/session';
import type { ActivateMode } from '@/shared/messages';
import { log } from '@/shared/log';
import { extractArticle } from '@/extract/readability';
import type { NewQueueItem } from '@/shared/reading-queue';
import { replyLater } from '@/shared/reply';

interface AloudGlobal {
  __aloudLoaded?: boolean;
  __aloudSession?: ReaderSession;
  __aloudActivate?: (mode: ActivateMode, targetElement?: Element | null) => void;
}

export default defineUnlistedScript(() => {
  const w = window as unknown as AloudGlobal;

  // Re-injection (background calls executeScript on every activation): the listener below is
  // already registered and the follow-up message drives activation, so there is nothing to do.
  if (w.__aloudLoaded) return;
  w.__aloudLoaded = true;

  const activate = (mode: ActivateMode, targetElement?: Element | null): void => {
    // Chromium hands a PDF tab to a plugin `<embed>`: the document's URL is the PDF, but its DOM
    // holds no text at all, so extraction can only ever fail here ("this page doesn't look like
    // an article"). The background opens Aloud's own PDF reader instead — it catches PDFs by URL
    // already, and this catches the rest, which are served without a `.pdf` in the path.
    if (document.contentType === 'application/pdf') {
      void browser.runtime.sendMessage({ type: 'open-pdf-reader' }).catch(() => undefined);
      return;
    }

    const session = w.__aloudSession;
    if (session && mode === 'article') {
      // Toolbar button / shortcut on an already-running session = play/pause toggle.
      void session.externalToggle();
      return;
    }
    // "Read selection" / "Read from here" always (re)plan from the new anchor.
    if (session) void session.dispose();
    const next = new ReaderSession();
    w.__aloudSession = next;
    void next.begin(mode, { targetElement: targetElement ?? null }).catch((err) =>
      log.error('session failed to start:', err),
    );
  };
  w.__aloudActivate = activate;

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (reply: unknown) => void) => {
    const m = msg as { type?: string; mode?: ActivateMode; targetElementId?: number };
    // "Add page to reading queue": extract now, while the page is open and readable. Answered with
    // `sendResponse`: a returned promise arrives as `undefined` in Chromium 120 (shared/reply.ts).
    if (m?.type === 'extract-for-queue') return replyLater(sendResponse, extractForQueue());
    if (m?.type !== 'activate') return false;
    let target: Element | null = null;
    if (m.targetElementId != null) {
      try {
        const menus = (browser as unknown as { menus?: { getTargetElement?: (id: number) => Element | null } }).menus;
        target = menus?.getTargetElement?.(m.targetElementId) ?? null;
      } catch {
        /* not available / stale id */
      }
    }
    activate(m.mode ?? 'article', target);
    return false;
  });

  window.addEventListener(
    'pagehide',
    () => {
      void w.__aloudSession?.dispose();
      w.__aloudSession = undefined;
    },
    { once: true },
  );
});

/** This page as a queue entry, or why it cannot be one. */
function extractForQueue(): NewQueueItem | { error: string } {
  if (document.contentType === 'application/pdf') return { error: 'PDFs cannot be queued yet' };
  // A saved copy keeps what the reader sees: no collapsed translations, no "Translate?" buttons.
  const article = extractArticle(document, { forSaving: true });
  if (!article.html && article.text.length < 200) return { error: "This page doesn't look like an article" };
  return {
    url: location.href,
    title: article.title || document.title || location.hostname,
    site: location.hostname,
    article: { html: article.html, text: article.text, lang: article.lang, byline: article.byline },
  };
}
