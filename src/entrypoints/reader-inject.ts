/**
 * Content script — injected on demand with `scripting.executeScript` (activeTab) when the user
 * activates the extension on a tab. Never declared in the manifest, so the extension asks for
 * no broad host permissions. Idempotent: re-injection is a no-op — the follow-up `activate`
 * message from the background carries the real mode.
 */
import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { ReaderSession } from '@/content/session';
import { caretAt } from '@/content/playlist-navigation';
import type { ActivateMode } from '@/shared/messages';
import { log } from '@/shared/log';
import { extractArticle } from '@/extract/readability';
import type { NewQueueItem } from '@/shared/reading-queue';
import { replyLater } from '@/shared/reply';
import { normalizePosition } from '@/shared/record-shapes';
import type { SavedPosition } from '@/shared/reading-positions';
import { articleFrame, framesOf } from '@/shared/frame-article';
import { removeFrameAskCard, showFrameAskCard } from '@/ui/frame-ask-card';

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

  const activate = (mode: ActivateMode, targetElement?: Element | null, fresh = false, resumeAt: SavedPosition | null = null): void => {
    // Chromium hands a PDF tab to a plugin `<embed>`: the document's URL is the PDF, but its DOM
    // holds no text at all, so extraction can only ever fail here ("this page doesn't look like
    // an article"). The background opens Aloud's own PDF reader instead — it catches PDFs by URL
    // already, and this catches the rest, which are served without a `.pdf` in the path.
    if (document.contentType === 'application/pdf') {
      void browser.runtime.sendMessage({ type: 'open-pdf-reader' }).catch(() => undefined);
      return;
    }

    const session = w.__aloudSession;
    // `fresh`: "Listen from here" in the Library, on a tab already being read — start again, so
    // the reader resumes at the sentence just saved.
    if (session && mode === 'article' && !fresh) {
      // Toolbar button / shortcut on an already-running session = play/pause toggle.
      void session.externalToggle();
      return;
    }
    // A page that only wraps another one in a frame (a Claude artifact): read the frame instead.
    if (!session && mode === 'article' && !resumeAt && window === window.top) {
      const frame = articleFrame(framesOf(document), window.innerWidth, window.innerHeight);
      if (frame && !hasOwnArticle()) {
        void readFrame(frame.src, () => activateHere(mode, targetElement, fresh, resumeAt));
        return;
      }
    }
    activateHere(mode, targetElement, fresh, resumeAt);
  };

  const activateHere = (mode: ActivateMode, targetElement?: Element | null, fresh = false, resumeAt: SavedPosition | null = null): void => {
    const session = w.__aloudSession;
    // "Read selection" / "Read from here" always (re)plan from the new anchor.
    if (session) void session.dispose();
    const next = new ReaderSession();
    w.__aloudSession = next;
    const startPoint = mode === 'from-cursor' ? rightClickFor(targetElement ?? null) : null;
    void next.begin(mode, { targetElement: targetElement ?? null, startPoint, resumeAt }).catch((err) =>
      log.error('session failed to start:', err),
    );
  };
  w.__aloudActivate = activate;

  // Where the last right-click landed, as a spot in the text, for "Read from here": the menu
  // itself says nothing (Chrome) or only which element (Firefox). Seen from the second time on,
  // once this script is in the page. A text position, so scrolling before choosing doesn't move it.
  let lastRightClick: { node: Node; offset: number; target: EventTarget | null; at: number } | null = null;
  window.addEventListener(
    'contextmenu',
    (e) => {
      const caret = caretAt(document, e.clientX, e.clientY);
      lastRightClick = caret ? { ...caret, target: e.target, at: Date.now() } : null;
    },
    { capture: true, passive: true },
  );
  const rightClickFor = (target: Element | null): { node: Node; offset: number } | null => {
    const c = lastRightClick;
    if (!c || Date.now() - c.at > 60_000) return null;
    // Firefox named the element: the recorded spot must be the same click.
    if (target && !(c.target instanceof Node && (target === c.target || target.contains(c.target)))) return null;
    return { node: c.node, offset: c.offset };
  };

  browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse: (reply: unknown) => void) => {
    const m = msg as { type?: string; mode?: ActivateMode; targetElementId?: number; fresh?: boolean; resumeAt?: unknown };
    // "Add page to reading queue": extract now, while the page is open and readable. Answered with
    // `sendResponse`: a returned promise arrives as `undefined` in Chromium 120 (shared/reply.ts).
    if (m?.type === 'extract-for-queue') return replyLater(sendResponse, extractForQueue());
    // The article is in a frame Aloud may not read yet (clicked there, from the menu).
    if (m?.type === 'frame-ask') {
      const ask = msg as { ticket?: unknown; site?: unknown };
      if (typeof ask.ticket === 'string' && typeof ask.site === 'string') showFrameAskCard(document, ask.ticket, ask.site);
      return false;
    }
    if (m?.type === 'frame-ask-close') {
      removeFrameAskCard(document);
      return false;
    }
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
    activate(m.mode ?? 'article', target, m.fresh === true, m.resumeAt == null ? null : normalizePosition(m.resumeAt));
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

/**
 * Does this page have an article of its own, beside the frame that covers most of it? A wrapper
 * (a Claude artifact's page holds 81 characters) has next to no text; a page with more is asked
 * the way the reader asks, and read itself when it has one.
 */
function hasOwnArticle(): boolean {
  if ((document.body?.innerText.trim().length ?? 0) < 1500) return false;
  try {
    return extractArticle(document).text.length >= 200;
  } catch {
    return false;
  }
}

/**
 * Read the article in the frame at `src`: the background starts the reader there, or says which
 * site to ask for, and the card asks. `otherwise`: this page, as before, when neither can be done.
 */
async function readFrame(src: string, otherwise: () => void): Promise<void> {
  const reply = (await browser.runtime.sendMessage({ type: 'read-in-frame', url: src }).catch(() => null)) as
    | { ok?: boolean; ask?: { ticket: string; site: string } }
    | null;
  if (reply?.ok) return;
  if (reply?.ask) {
    showFrameAskCard(document, reply.ask.ticket, reply.ask.site);
    return;
  }
  otherwise();
}

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
