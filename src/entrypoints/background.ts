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
import { PORT_NAME, type ActivateMode, type LibraryTab, type ToBackgroundMessage } from '@/shared/messages';
import { addNote } from '@/shared/notes';
import { siteOf } from '@/shared/doc-source';
import { documentKey } from '@/shared/position-match';
import { putPdf, sweepPdfHandoffs } from '@/pdf/handoff';
import { readCacheSizes, usableVoices } from '@/engine/installed-voices';
import { addToQueue, type NewQueueItem } from '@/shared/reading-queue';
import type { EngineId } from '@/shared/settings';
import type { VoiceOption } from '@/shared/voice-catalog';
import type { ModelManifest } from '@/engine/engines/types';
import { getSettings, watchSettings } from '@/shared/settings';
import { createLockTable } from '@/shared/storage-lock';

const CONTENT_FILE = '/reader-inject.js';
/** The media speed control (src/entrypoints/speed-inject.ts). */
const SPEED_FILE = '/speed-inject.js';
const SPEED_SCRIPT_ID = 'aloud-media-speed';
/** Highlights and notes on web pages (src/entrypoints/annotate-inject.ts). */
const ANNOTATE_FILE = '/annotate-inject.js';
const ANNOTATE_SCRIPT_ID = 'aloud-annotate';
const MENU_HIGHLIGHT = 'aloud-highlight';
const WALKTHROUGH_PAGE = '/welcome.html';
/** Aloud's page; the Library is its first views (`#continue`, `#notes`, …). */
const LIBRARY_PAGE = '/options.html';

const MENU_READ_SELECTION = 'aloud-read-selection';
const MENU_READ_FROM_HERE = 'aloud-read-from-here';
const MENU_QUEUE_PAGE = 'aloud-queue-page';
const MENU_QUEUE_LINK = 'aloud-queue-link';
const MENU_OPEN_QUEUE = 'aloud-open-queue';
const MENU_NOTES_PANEL = 'aloud-notes-panel';

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


/** Serialises read-modify-write storage across contexts (shared/storage-lock.ts). */
const locks = createLockTable();

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
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (command === 'toggle-read') {
          if (tab?.id != null) void activate(tab.id, 'article');
        } else if (command === 'save-note') {
          void saveNoteCommand(tab?.id ?? null, tab?.url ?? '', tab?.title ?? '');
        } else if (command === 'notes-panel') {
          if (tab?.id != null) void showNotesPanel(tab.id);
          else void openLibrary('notes');
        } else if (command === 'media-speed') {
          if (tab?.id != null) void startSpeedControl(tab.id);
        } else if (command === 'back-a-little') {
          if (active) postToActive({ type: 'back-a-little' });
          else if (tab?.id != null) tellTab(tab.id, 'Start reading first', '…');
        }
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
            id: MENU_HIGHLIGHT,
            title: 'Highlight and keep in Notes',
            contexts: ['selection'],
          });
          browser.contextMenus.create({
            id: MENU_READ_SELECTION,
            title: 'Read selection aloud',
            contexts: ['selection'],
          });
          browser.contextMenus.create({
            id: MENU_NOTES_PANEL,
            title: 'Show my notes',
            contexts: ['page', 'selection'],
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
            title: 'Open Library (queue, notes, continue listening)',
            contexts: ['action'],
          });
        });
      });

      browser.contextMenus.onClicked.addListener((info, tab) => {
        // The toolbar button's own menu is not about a page, and may arrive without a tab.
        if (info.menuItemId === MENU_OPEN_QUEUE) {
          void openLibrary('queue');
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
        else if (info.menuItemId === MENU_HIGHLIGHT) void highlightSelection(tab.id, tab.url ?? '', tab.title ?? '');
        else if (info.menuItemId === MENU_NOTES_PANEL) void showNotesPanel(tab.id);
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
        void openLibrary('queue');
      } else if (m?.type === 'open-and-read') {
        const url = (m as { url?: string }).url;
        if (url) void openAndRead(url).catch((err) => console.warn('[aloud] could not reopen', url, err));
      } else if (m?.type === 'open-note') {
        const note = m as { id?: string; url?: string; fragmentUrl?: string; canInject?: boolean; checkAccess?: boolean };
        if (note.id && note.url) {
          const { id, url } = note;
          // From the page's notes panel, which cannot ask for permissions: draw the highlights
          // only where the site is already granted, and use the text link elsewhere.
          const access = note.checkAccess ? siteGranted(url) : Promise.resolve(note.canInject === true);
          void access.then((canInject) => openNote(id, url, note.fragmentUrl ?? url, canInject));
        }
      } else if (m?.type === 'open-library') {
        void openLibrary((m as { tab?: LibraryTab }).tab);
      } else if (m?.type === 'storage-lock') {
        // One writer at a time per stored value, across every context (shared/storage-lock.ts).
        const key = (m as { key?: string }).key;
        if (typeof key === 'string') return locks.acquire(key).then((token) => ({ token }));
      } else if (m?.type === 'storage-unlock') {
        const { key, token } = m as { key?: string; token?: number };
        if (typeof key === 'string' && typeof token === 'number') locks.release(key, token);
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
        } else if (msg.type === 'open-library') {
          void openLibrary(msg.tab);
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

    void syncSpeedSites();

    // Relay settings changes to the running session.
    watchSettings(() => {
      void syncSpeedSites();
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

  // One of Aloud's own pages (the PDF reader, the Library's queue): its reader is already there,
  // so the button plays or pauses it, as it does on any page that is being read.
  if (tab?.url?.startsWith(browser.runtime.getURL('/')) && active && (active.tabId === tabId || active.tabId === null)) {
    postToActive({ type: 'toggle' });
    return;
  }

  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
    void browser.scripting.executeScript({ target: { tabId }, files: [ANNOTATE_FILE] }).catch(() => undefined);
  } catch (err) {
    // about:, chrome://, the new tab page, view-source:, the add-on stores, reader mode, Aloud's
    // own pages, file:// without access: nothing of ours may run here. Answer with something
    // visible — the settings page, saying why — rather than a badge nobody notices.
    console.info('[aloud] cannot read this page, opening settings instead:', err);
    await openSettingsInstead(tab);
    return;
  }
  await sendActivate(tabId, mode, targetElementId, 2);
}

/** Pages that are only somewhere to start from: opening settings over them loses nothing. */
const EMPTY_PAGE =
  /^(about:(newtab|home|blank|privatebrowsing)|chrome:\/\/(newtab|new-tab-page)\/?|edge:\/\/newtab\/?|chrome-search:\/\/local-ntp|chrome:\/\/vivaldi-webui\/startpage)/i;

/**
 * The toolbar button on a page Aloud cannot read: show its settings, with a line saying why.
 *
 * On a new tab page they open right there — there is nothing to lose. Anywhere else (the
 * browser's own settings, an add-on store, a local file without access) they open beside it, so
 * the page the reader was on is not thrown away; an Aloud settings tab already open is reused.
 */
async function openSettingsInstead(tab: { id?: number; index?: number; url?: string } | null): Promise<void> {
  const reason = tab?.url?.startsWith('file:') ? 'file' : 'page';
  const url = `${browser.runtime.getURL('/options.html')}#cant-read-${reason}`;
  try {
    if (tab?.id != null && (!tab.url || EMPTY_PAGE.test(tab.url))) {
      await browser.tabs.update(tab.id, { url });
      return;
    }
    const base = browser.runtime.getURL('/options.html');
    const [existing] = await browser.tabs.query({ url: `${base}*` }).catch(() => []);
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { url, active: true });
      if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true }).catch(() => undefined);
      return;
    }
    await browser.tabs.create({ url, index: tab?.index != null ? tab.index + 1 : undefined });
  } catch (err) {
    console.warn('[aloud] could not open the settings page:', err);
    if (tab?.id != null) {
      setBadge(tab.id, 'n/a');
      setTimeout(() => clearBadge(tab.id!), 2500);
    }
  }
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

/**
 * "Continue" / "Listen from here" in the Library: open the document and start the reader, which
 * resumes at the saved position. The Library has already asked for permission for the site.
 */
async function openAndRead(url: string): Promise<void> {
  if (looksLikePdf(url)) {
    await openPdfReader(url, null);
    return;
  }
  const tab = await browser.tabs.create({ url });
  if (tab.id == null) return;
  await waitForLoad(tab.id);
  await activate(tab.id, 'article');
}

/**
 * Put the media speed control into a tab, in every frame — embedded players (YouTube in an
 * article, a lecture in a course site) are frames of their own.
 */
async function startSpeedControl(tabId: number): Promise<void> {
  const { mediaSpeed } = await getSettings();
  if (!mediaSpeed.enabled) {
    tellTab(tabId, 'Video speed control is switched off in Aloud\u2019s settings', '…');
    return;
  }
  try {
    await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: [SPEED_FILE] });
  } catch (err) {
    // about:, the web stores, a PDF viewer: nothing of ours may run there.
    console.warn('[aloud] cannot control media speed on this page:', err);
    setBadge(tabId, 'n/a');
    setTimeout(() => clearBadge(tabId), 2500);
  }
}

/**
 * Keep the always-on registration in step with the setting.
 *
 * Only sites whose permission has actually been granted are registered — the settings page asks
 * for each one from the user's click, and a permission revoked in the browser's own UI simply
 * drops the site from the registration on the next change.
 */
async function syncSpeedSites(): Promise<void> {
  const { mediaSpeed, annotate } = await getSettings();
  await syncRegistration(SPEED_SCRIPT_ID, SPEED_FILE, mediaSpeed.enabled ? mediaSpeed.alwaysOn : [], true);
  await syncRegistration(ANNOTATE_SCRIPT_ID, ANNOTATE_FILE, annotate.alwaysOn, false);
}

/** Register `file` for the granted ones among `hosts` (`*` = every site), replacing any earlier registration. */
async function syncRegistration(id: string, file: string, hosts: readonly string[], allFrames: boolean): Promise<void> {
  if (!browser.scripting?.registerContentScripts) return;
  try {
    const wanted: string[] = [];
    for (const host of hosts) {
      const matches = host === '*' ? ['*://*/*'] : [`*://${host}/*`, `*://*.${host}/*`];
      if (await browser.permissions.contains({ origins: matches }).catch(() => false)) wanted.push(...matches);
    }
    const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
    if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [id] });
    if (wanted.length === 0) return;
    await browser.scripting.registerContentScripts([
      { id, js: [file.slice(1)], matches: [...new Set(wanted)], allFrames, runAt: 'document_idle', persistAcrossSessions: true },
    ]);
    console.info(`[aloud] ${id} runs by itself on ${new Set(wanted).size} pattern(s)`);
  } catch (err) {
    console.warn(`[aloud] could not register ${id}:`, err);
  }
}

/**
 * Keep the selected text as a highlight: the annotator anchors it so it is highlighted again on
 * every later visit. Resolves false when that could not happen (no access to the page, nothing
 * selected), so the caller can fall back.
 */
async function highlightSelection(tabId: number, _url: string, _title: string, quiet = false): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [ANNOTATE_FILE] });
    const reply = (await sendWithRetry<{ saved?: boolean }>(tabId, { type: 'annotate-save-selection', quiet }, 3)) ?? {};
    return reply.saved === true;
  } catch {
    return false;
  }
}

/**
 * Open a note's page at the note. With the site granted (the Library asks from the click), the
 * annotator is injected, draws every highlight and scrolls to this one. Without it, the browser's
 * own text fragment link still scrolls to the passage and marks it — no permission needed.
 */
async function openNote(id: string, url: string, fragmentUrl: string, canInject: boolean): Promise<void> {
  const target = documentKey(url);
  let tab = (await browser.tabs.query({}).catch(() => [])).find((t) => t.url && documentKey(t.url) === target);
  if (!canInject) {
    if (tab?.id != null) await browser.tabs.update(tab.id, { active: true, url: fragmentUrl });
    else await browser.tabs.create({ url: fragmentUrl });
    return;
  }
  if (tab?.id != null) {
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  } else {
    tab = await browser.tabs.create({ url });
    await waitForLoad(tab.id!);
  }
  const tabId = tab.id!;
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [ANNOTATE_FILE] });
    await sendWithRetry(tabId, { type: 'annotate-reveal', id }, 3);
  } catch (err) {
    console.warn('[aloud] could not show the note on the page; using a text link instead:', err);
    await browser.tabs.update(tabId, { url: fragmentUrl });
  }
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }): void => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, 20_000);
    browser.tabs.onUpdated.addListener(listener);
    // A page that finished loading before the listener was attached (about:blank, a cached
    // page) sends no further update; without this it waited out the whole timeout.
    void browser.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') done();
    }, done);
  });
}

/** Show the Library at `tab`, reusing its tab if one is open. */
async function openLibrary(tab: LibraryTab = 'continue'): Promise<void> {
  const base = browser.runtime.getURL(LIBRARY_PAGE);
  const url = `${base}#${tab}`;
  try {
    const [existing] = await browser.tabs.query({ url: `${base}*` });
    if (existing?.id != null) {
      await browser.tabs.update(existing.id, { active: true, url });
      return;
    }
  } catch {
    /* fall through to a new tab */
  }
  await browser.tabs.create({ url });
}

function postToActive(message: unknown): boolean {
  if (!active) return false;
  try {
    active.port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * The notes panel on the page (annotate/notes-panel.ts). On a page Aloud cannot run on (the
 * browser's own pages, the store), the notes open in Aloud's page instead, unless `fallback` is
 * false. Resolves whether the panel was shown.
 */
async function showNotesPanel(tabId: number, fallback = true): Promise<boolean> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [ANNOTATE_FILE] });
    const reply = await sendWithRetry<{ shown?: boolean }>(tabId, { type: 'annotate-panel' }, 3);
    if (reply?.shown) return true;
  } catch {
    /* not a page scripts may run on */
  }
  if (fallback) await openLibrary('notes');
  return false;
}

/** Whether Aloud may already run on `url`'s site, without asking. */
async function siteGranted(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return await browser.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch {
    return false;
  }
}

/**
 * The "save to notes" shortcut. With the reader running, the reader saves what is being heard
 * (it knows the sentence and its place). Without it, the page's selection is saved straight away
 * — reading does not have to be started just to keep a quotation.
 */
async function saveNoteCommand(tabId: number | null, url: string, title: string): Promise<void> {
  // Only the reader *in this tab* gets the key. A session with no tab id is one of Aloud's own
  // pages (the PDF reader): it used to swallow the shortcut from every other tab, so pressing it
  // on an article kept the PDF's sentence instead of the article's selection.
  const ownPage = url.startsWith(browser.runtime.getURL('/'));
  if (active && (active.tabId === tabId || (active.tabId === null && ownPage))) {
    postToActive({ type: 'save-note' });
    return;
  }
  if (tabId == null) return;
  if (await highlightSelection(tabId, url, title, true)) return;
  let text = '';
  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => getSelection()?.toString() ?? '',
    });
    text = String(result?.result ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    /* a page scripts may not run on (the store, browser pages) */
  }
  if (!text) {
    // Nothing to keep: show the notes instead, which is what reaching for the notes key with
    // nothing selected is usually after.
    if (!(await showNotesPanel(tabId, false))) tellTab(tabId, 'Select some text, or start reading, to save a note', '…');
    return;
  }
  const { duplicate } = await addNote({
    text,
    source: { key: documentKey(url), title: title || url, site: siteOf(url), reopen: { kind: 'web', url } },
    at: null,
  });
  tellTab(tabId, duplicate ? 'Already in your notes' : 'Saved to Notes', '✓');
}
