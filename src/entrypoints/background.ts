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
import { watchSettings } from '@/shared/settings';

const CONTENT_FILE = '/reader-inject.js';

const MENU_READ_SELECTION = 'aloud-read-selection';
const MENU_READ_FROM_HERE = 'aloud-read-from-here';

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

interface ActiveSession {
  tabId: number;
  port: Port;
}

let active: ActiveSession | null = null;

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
        });
      });

      browser.contextMenus.onClicked.addListener((info, tab) => {
        if (tab?.id == null) return;
        // `targetElementId` (Firefox only) lets the content script resolve the exact element
        // that was right-clicked via `browser.menus.getTargetElement()`, so "Read from here"
        // starts there. Elsewhere it is undefined and the content script falls back to the
        // first sentence in the viewport.
        const targetElementId = (info as { targetElementId?: number }).targetElementId;
        if (info.menuItemId === MENU_READ_SELECTION) void activate(tab.id, 'selection');
        else if (info.menuItemId === MENU_READ_FROM_HERE) {
          void activate(tab.id, 'from-cursor', targetElementId);
        }
      });
    });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAME) return;
      const tabId = port.sender?.tab?.id;
      if (tabId == null) return;

      // Supersede any other active session.
      if (active && active.tabId !== tabId) {
        try {
          active.port.postMessage({ type: 'stop', reason: 'superseded' });
        } catch {
          /* that tab is already gone */
        }
      }
      active = { tabId, port };
      setBadge(tabId, '•');

      port.onMessage.addListener((msg: ToBackgroundMessage) => {
        if (msg.type === 'state') {
          setBadge(tabId, badgeFor(msg.state.status));
        } else if (msg.type === 'open-options') {
          void browser.runtime.openOptionsPage();
        } else if (msg.type === 'session-ended') {
          // Compare the port, not just the tab: a replacement session ("Read from here" /
          // "Read selection" on a running reader) may already hold the slot for this tab.
          if (active?.port === port) {
            active = null;
            clearBadge(tabId);
          }
        }
      });

      port.onDisconnect.addListener(() => {
        if (active?.port === port) {
          active = null;
          clearBadge(tabId);
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

async function activate(tabId: number, mode: ActivateMode, targetElementId?: number): Promise<void> {
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
