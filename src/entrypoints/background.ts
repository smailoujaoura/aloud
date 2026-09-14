/**
 * Background: an event page on Firefox, a service worker on Chromium.
 *
 * Deliberately thin, and it has to be: it routes activation, keeps a single-active-session
 * invariant, mirrors playback state to the toolbar badge, and relays settings changes. No audio,
 * no inference, no model downloads happen here — none of those would survive the ~30s idle
 * eviction either browser applies, and a Chromium service worker has no DOM to play audio with
 * in the first place. All of that lives in the content script and the workers it owns.
 *
 * The one piece of state here, `active`, is a cache rather than a source of truth: if the
 * background is evicted it is rebuilt by the next port connection, and a stale badge is the
 * worst case.
 *
 * Not every API is present everywhere — Firefox for Android has no `commands` and no
 * `contextMenus`, and its badge support varies. Every optional API is therefore registered
 * through `optional()`, so one missing namespace degrades that one feature instead of throwing
 * partway through `main()` and leaving the rest of the listeners unregistered.
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { PORT_NAME, type ActivateMode, type ToBackgroundMessage } from '@/shared/messages';
import { putPdf, sweepPdfHandoffs } from '@/pdf/handoff';
import { readCacheSizes, usableVoices } from '@/engine/installed-voices';
import { addToQueue, type NewQueueItem } from '@/shared/reading-queue';
import type { EngineId } from '@/shared/settings';
import type { VoiceOption } from '@/shared/voice-catalog';
import type { ModelManifest } from '@/engine/engines/types';
import { watchSettings } from '@/shared/settings';

const CONTENT_FILE = '/reader-inject.js';
const WALKTHROUGH_PAGE = '/welcome.html';
const QUEUE_PAGE = '/queue.html';

const MENU_READ_SELECTION = 'aloud-read-selection';
const MENU_READ_FROM_HERE = 'aloud-read-from-here';
const MENU_QUEUE_PAGE = 'aloud-queue-page';
const MENU_QUEUE_LINK = 'aloud-queue-link';
const MENU_OPEN_QUEUE = 'aloud-open-queue';

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

interface ActiveSession {
  /** Absent for the PDF reader page, which is an extension page and has no badge of its own. */
  tabId: number | null;
  port: Port;
}

let active: ActiveSession | null = null;

/**
 * PDFs are fetched *here*, at the moment of the click, because this is where the permission
 * exists: `activeTab` covers the tab's own URL for as long as the user stays on it, and
 * Chromium's per-extension "Allow access to file URLs" covers `file://`. Handing the reader page
 * a bare URL instead would ask it to re-fetch something it may have no permission for.
 *
 * The bytes travel through IndexedDB (`pdf/handoff.ts`), not through a message: Chromium
 * serialises extension messages as JSON, which turns an ArrayBuffer into `{}`.
 */

/** Run `fn`, logging and swallowing a missing-API failure rather than aborting startup. */
function optional(feature: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.info(`[aloud] ${feature} is unavailable in this browser:`, err);
  }
}

export default defineBackground({
  type: 'module',
  main() {
    // First run: open the walkthrough. An extension whose entire UI is a toolbar button and a
    // bar that appears on top of someone else's page has nowhere to explain itself in place, so
    // the one moment it can is the moment it is installed. Only on `install` — nobody wants a
    // tutorial tab every time their browser updates the add-on.
    browser.runtime.onInstalled.addListener((details) => {
      if (details.reason !== 'install') return;
      void openWalkthrough();
    });

    browser.action.onClicked.addListener((tab) => {
      if (tab.id != null) void activate(tab.id, 'article');
    });

    // Keyboard shortcut. Absent on Firefox for Android.
    optional('commands', () => {
      browser.commands.onCommand.addListener(async (command) => {
        if (command !== 'toggle-read') return;
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) void activate(tab.id, 'article');
      });
    });

    // Right-click entries. Absent on Firefox for Android.
    optional('contextMenus', () => {
      // Checked before registering anything, so we don't leave an onInstalled listener behind
      // that would throw later on a browser without the namespace.
      if (!browser.contextMenus) throw new Error('browser.contextMenus is undefined');

      browser.runtime.onInstalled.addListener(() => {
        // `onInstalled` also fires on update and on browser update, when the items already
        // exist; Chromium rejects a duplicate id outright, so start from a clean slate.
        void Promise.resolve(browser.contextMenus.removeAll()).then(() => {
          browser.contextMenus.create({
            id: MENU_READ_SELECTION,
            title: 'Read selection aloud',
            contexts: ['selection'],
          });
          browser.contextMenus.create({
            id: MENU_READ_FROM_HERE,
            title: 'Read from here',
            contexts: ['page'],
          });
          browser.contextMenus.create({
            id: MENU_QUEUE_PAGE,
            title: 'Add page to reading queue',
            contexts: ['page'],
          });
          browser.contextMenus.create({
            id: MENU_QUEUE_LINK,
            title: 'Add link to reading queue',
            contexts: ['link'],
          });
          // On the toolbar button's own right-click menu, where "where is my queue" is looked for.
          browser.contextMenus.create({
            id: MENU_OPEN_QUEUE,
            title: 'Open reading queue',
            contexts: ['action'],
          });
        });
      });

      browser.contextMenus.onClicked.addListener((info, tab) => {
        // The toolbar button's own menu is not about a page, and may arrive without a tab.
        if (info.menuItemId === MENU_OPEN_QUEUE) {
          void openQueue();
          return;
        }
        if (tab?.id == null) return;
        // `targetElementId` (Firefox only) lets the content script resolve the exact element
        // that was right-clicked via `browser.menus.getTargetElement()`, so "Read from here"
        // starts there. Elsewhere it is undefined and the content script falls back to the
        // first sentence in the viewport.
        const targetElementId = (info as { targetElementId?: number }).targetElementId;
        if (info.menuItemId === MENU_QUEUE_PAGE) void queuePage(tab.id);
        else if (info.menuItemId === MENU_QUEUE_LINK && info.linkUrl) void queueLink(tab.id, info);
        else if (info.menuItemId === MENU_READ_SELECTION) void activate(tab.id, 'selection');
        else if (info.menuItemId === MENU_READ_FROM_HERE) {
          void activate(tab.id, 'from-cursor', targetElementId);
        }
      });
    });

    // The content script telling us the page it was injected into is really a PDF: Chromium
    // renders one inside a plugin <embed> whose document has no text, which is what used to
    // surface as "this page doesn't look like an article".
    browser.runtime.onMessage.addListener((msg: unknown, sender) => {
      const m = msg as { type?: string; engine?: EngineId };
      if (m?.type === 'open-pdf-reader') {
        const tab = sender.tab;
        if (tab?.url) void openPdfReader(tab.url, tab.id ?? null, tab.index);
      } else if (m?.type === 'open-walkthrough') {
        void openWalkthrough();
      } else if (m?.type === 'open-queue') {
        void openQueue();
      } else if (m?.type === 'installed-voices') {
        // Answered here because only an extension-origin context can read the model cache: the
        // reading bar lives in the page, whose IndexedDB is a different origin entirely.
        // Returning a promise is how both browsers reply asynchronously.
        return installedVoices(m.engine ?? 'piper');
      }
      return false;
    });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAME) return;
      // No tab id means the PDF reader page (an extension page, not a content script). It is a
      // real session and must supersede any other one; it simply has no toolbar badge.
      const tabId = port.sender?.tab?.id ?? null;

      // Supersede any other active session.
      if (active && active.tabId !== tabId) {
        try {
          active.port.postMessage({ type: 'stop', reason: 'superseded' });
        } catch {
          /* that tab is already gone */
        }
      }
      active = { tabId, port };
      if (tabId != null) setBadge(tabId, '•');

      port.onMessage.addListener((msg: ToBackgroundMessage) => {
        if (msg.type === 'state') {
          if (tabId != null) setBadge(tabId, badgeFor(msg.state.status));
        } else if (msg.type === 'open-options') {
          void browser.runtime.openOptionsPage();
        } else if (msg.type === 'open-walkthrough') {
          void openWalkthrough();
        } else if (msg.type === 'session-ended') {
          // Compare the port, not just the tab: a replacement session ("Read from here" /
          // "Read selection" on a running reader) may already hold the slot for this tab.
          if (active?.port === port) {
            active = null;
            if (tabId != null) clearBadge(tabId);
          }
        }
      });

      port.onDisconnect.addListener(() => {
        if (active?.port === port) {
          active = null;
          if (tabId != null) clearBadge(tabId);
        }
      });
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      if (active?.tabId === tabId) active = null;
    });

    // Relay settings changes to the running session.
    watchSettings(() => {
      if (!active) return;
      try {
        active.port.postMessage({ type: 'settings-changed' });
      } catch {
        /* the session is gone; onDisconnect will clear it */
      }
    });
  },
});

/**
 * Show the walkthrough, reusing its tab if it is already open.
 *
 * Opening a second copy of a tutorial someone already has open is the kind of small rudeness
 * that makes an extension feel careless, and the page keeps no state worth restarting.
 */
async function openWalkthrough(): Promise<void> {
  const url = browser.runtime.getURL(WALKTHROUGH_PAGE);
  try {
    const [existing] = await browser.tabs.query({ url });
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
  } catch {
    // `tabs.query` by URL needs the tabs permission, which we have — but Android builds have
    // been known to reject the filter. Falling through just opens a new tab.
  }
  try {
    await browser.tabs.create({ url });
  } catch (err) {
    console.warn('[aloud] could not open the walkthrough:', err);
  }
}

async function activate(tabId: number, mode: ActivateMode, targetElementId?: number): Promise<void> {
  // A PDF is never an article: Chromium hands the tab to a plugin <embed> with no text in its
  // DOM, and Firefox renders it in a privileged viewer no content script can touch. Read it in
  // Aloud's own PDF page instead of injecting into something unreadable.
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab?.url && looksLikePdf(tab.url)) {
    await openPdfReader(tab.url, tabId, tab.index);
    return;
  }

  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
  } catch (err) {
    // about:, chrome://, view-source:, the PDF viewer, the extension galleries, reader mode, …
    setBadge(tabId, 'n/a');
    setTimeout(() => clearBadge(tabId), 2500);
    console.warn('[aloud] cannot inject into this page:', err);
    return;
  }
  await sendActivate(tabId, mode, targetElementId, 2);
}

/**
 * The content script registers its message listener during evaluation, but `executeScript`
 * resolving does not guarantee that has happened yet on every browser — so retry briefly rather
 * than dropping the activation the user just asked for.
 */
async function sendActivate(
  tabId: number,
  mode: ActivateMode,
  targetElementId: number | undefined,
  retries: number,
): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'activate', mode, targetElementId });
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 120));
      return sendActivate(tabId, mode, targetElementId, retries - 1);
    }
    console.warn('[aloud] activate message not delivered:', err);
  }
}

/** Does this URL name a PDF? The only signal available before anything is loaded. */
function looksLikePdf(url: string): boolean {
  try {
    const { pathname, protocol } = new URL(url);
    if (!/^(https?|file|ftp):$/.test(protocol)) return false;
    return /\.pdf$/i.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Open a PDF in Aloud's reader page.
 *
 * The bytes are fetched here and now, while the user's click still grants `activeTab` for that
 * URL. If the fetch fails — Firefox refuses `file://` to add-ons entirely, and Chromium does
 * until "Allow access to file URLs" is switched on — the page still opens, carrying the reason,
 * and offers the file picker, which needs no permission anywhere.
 */
async function openPdfReader(url: string, sourceTabId: number | null, index?: number): Promise<void> {
  let job: string | null = null;
  let reason = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    void sweepPdfHandoffs();
    await putPdf(job, { data, name: fileNameOf(url), url });
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    console.info(`[aloud] could not read ${url} in the background:`, reason);
  }

  const params = new URLSearchParams({ src: url });
  if (job) params.set('job', job);
  else if (reason) params.set('reason', reason);

  const readerUrl = browser.runtime.getURL(`/pdf.html?${params.toString()}`);
  try {
    // In place, not in a new tab: the user asked to read *this* document, and a second tab
    // showing the same file is clutter they then have to close. Back returns to the original.
    if (sourceTabId != null) await browser.tabs.update(sourceTabId, { url: readerUrl });
    else await browser.tabs.create({ url: readerUrl, index: index == null ? undefined : index + 1 });
  } catch (err) {
    console.warn('[aloud] could not open the PDF reader tab:', err);
    if (sourceTabId != null) {
      setBadge(sourceTabId, 'n/a');
      setTimeout(() => clearBadge(sourceTabId), 2500);
    }
  }
}

function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
  } catch {
    return url;
  }
}

function badgeFor(status: string): string {
  switch (status) {
    case 'playing':
      return '▶';
    case 'paused':
      return 'II';
    case 'error':
      return '!';
    default:
      return '•';
  }
}

/** Badges are decorative, and unsupported on some Android builds — never let one throw. */
function setBadge(tabId: number, text: string): void {
  try {
    void Promise.resolve(browser.action.setBadgeText({ tabId, text })).catch(() => undefined);
    void Promise.resolve(
      browser.action.setBadgeBackgroundColor?.({ tabId, color: '#1c1c22' }),
    )?.catch(() => undefined);
  } catch {
    /* no badge support on this build */
  }
}

function clearBadge(tabId: number): void {
  setBadge(tabId, '');
}

/**
 * The voices of `engine` whose files are on this device.
 *
 * The in-page reading bar offers only these: switching to a voice that is not downloaded used to
 * stall the reader behind a 60 MB fetch chosen by accident from a list of 175.
 */
let manifestCache: ModelManifest | null = null;

async function installedVoices(engine: EngineId): Promise<VoiceOption[]> {
  try {
    manifestCache ??= (await (await fetch(browser.runtime.getURL('/models.json'))).json()) as ModelManifest;
    return usableVoices(engine, manifestCache, await readCacheSizes());
  } catch (err) {
    // An empty list means "we do not know", and the bar keeps showing the active voice alone.
    console.warn('[aloud] could not list installed voices:', err);
    return [];
  }
}

// ---- reading queue ---------------------------------------------------------

/** Extract the tab's article and queue it. */
async function queuePage(tabId: number): Promise<void> {
  let reply: NewQueueItem | { error: string } | undefined;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
    reply = await sendWithRetry(tabId, { type: 'extract-for-queue' }, 2);
  } catch (err) {
    console.warn('[aloud] cannot queue this page:', err);
  }
  if (!reply || 'error' in reply) {
    tellTab(tabId, reply && 'error' in reply ? reply.error : 'This page cannot be queued', '!');
    return;
  }
  await reportQueued(tabId, await addToQueue(reply), reply.title);
}

/** Queue a link without opening it: the queue page downloads the article when its turn comes. */
async function queueLink(tabId: number, info: { linkUrl?: string; selectionText?: string }): Promise<void> {
  const url = info.linkUrl!;
  let site = '';
  try {
    site = new URL(url).hostname;
  } catch {
    tellTab(tabId, 'That link cannot be queued', '!');
    return;
  }
  // Firefox passes the link's own text; Chromium only has the selection, if any.
  const text = (info as { linkText?: string }).linkText ?? info.selectionText ?? '';
  const title = text.trim() || url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80);
  await reportQueued(tabId, await addToQueue({ url, title, site }), title);
}

async function reportQueued(
  tabId: number,
  result: { added: boolean; full: boolean; size: number },
  title: string,
): Promise<void> {
  const short = title.length > 48 ? `${title.slice(0, 47)}…` : title;
  if (result.full) tellTab(tabId, 'Your reading queue is full — play or clear some of it first', '!');
  else if (!result.added) tellTab(tabId, `“${short}” is already in your reading queue`, '✓');
  else tellTab(tabId, `Added “${short}” to your reading queue (${result.size})`, `+${Math.min(result.size, 99)}`);
}

/**
 * Confirm something to the user on `tabId`: in the reading bar when a session is running there,
 * else as a brief badge on the toolbar button.
 */
function tellTab(tabId: number, text: string, badge: string): void {
  if (active?.tabId === tabId) {
    try {
      active.port.postMessage({ type: 'flash', text });
      return;
    } catch {
      /* fall back to the badge */
    }
  }
  setBadge(tabId, badge);
  setTimeout(() => {
    if (active?.tabId !== tabId) clearBadge(tabId);
  }, 2200);
}

async function sendWithRetry<T>(tabId: number, message: unknown, retries: number): Promise<T | undefined> {
  try {
    return (await browser.tabs.sendMessage(tabId, message)) as T;
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 120));
    return sendWithRetry<T>(tabId, message, retries - 1);
  }
}

async function openQueue(): Promise<void> {
  const url = browser.runtime.getURL(QUEUE_PAGE);
  try {
    const [existing] = await browser.tabs.query({ url });
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
  } catch {
    /* fall through to a new tab */
  }
  await browser.tabs.create({ url });
}
