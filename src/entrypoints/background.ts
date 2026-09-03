/**
 * Background event page (Firefox MV3). Deliberately thin: it routes activation, keeps a
 * single-active-session invariant, mirrors playback state to the toolbar badge, and relays
 * settings changes. No audio, no inference, no model downloads happen here — those would not
 * survive the ~30s event-page idle timeout.
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { PORT_NAME, type ActivateMode, type ToBackgroundMessage } from '@/shared/messages';
import { watchSettings } from '@/shared/settings';

const CONTENT_FILE = '/reader-inject.js';

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0];

interface ActiveSession {
  tabId: number;
  port: Port;
}

let active: ActiveSession | null = null;

export default defineBackground({
  type: 'module',
  main() {
    browser.action.onClicked.addListener((tab) => {
      if (tab.id != null) void activate(tab.id, 'article');
    });

    browser.commands.onCommand.addListener(async (command) => {
      if (command !== 'toggle-read') return;
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) void activate(tab.id, 'article');
    });

    browser.runtime.onInstalled.addListener(() => {
      browser.contextMenus.create({
        id: 'aloud-read-selection',
        title: 'Read selection aloud',
        contexts: ['selection'],
      });
      browser.contextMenus.create({
        id: 'aloud-read-from-here',
        title: 'Read from here',
        contexts: ['page'],
      });
    });

    browser.contextMenus.onClicked.addListener((info, tab) => {
      if (tab?.id == null) return;
      // `targetElementId` (Firefox) lets the content script resolve the exact element that was
      // right-clicked via `browser.menus.getTargetElement()`, so "Read from here" starts there.
      const targetElementId = (info as { targetElementId?: number }).targetElementId;
      if (info.menuItemId === 'aloud-read-selection') void activate(tab.id, 'selection');
      else if (info.menuItemId === 'aloud-read-from-here') void activate(tab.id, 'from-cursor', targetElementId);
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
          /* noop */
        }
      }
      active = { tabId, port };
      setBadge(tabId, '•');

      port.onMessage.addListener((msg: ToBackgroundMessage) => {
        if (msg.type === 'state') {
          const s = msg.state;
          const icon = s.status === 'playing' ? '▶' : s.status === 'error' ? '!' : s.status === 'paused' ? 'II' : '•';
          setBadge(tabId, icon);
        } else if (msg.type === 'open-options') {
          void browser.runtime.openOptionsPage();
        } else if (msg.type === 'session-ended') {
          // Compare the port, not just the tab: a replacement session (Read from here / Read
          // selection on a running reader) may already hold the slot for this tab.
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
      if (active) {
        try {
          active.port.postMessage({ type: 'settings-changed' });
        } catch {
          /* noop */
        }
      }
    });
  },
});

async function activate(tabId: number, mode: ActivateMode, targetElementId?: number): Promise<void> {
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
  } catch (err) {
    // about:, view-source:, PDF viewer, addons.mozilla.org, reader mode, etc.
    setBadge(tabId, 'n/a');
    setTimeout(() => clearBadge(tabId), 2500);
    console.warn('[aloud] cannot inject into this page:', err);
    return;
  }
  await sendActivate(tabId, mode, targetElementId, 2);
}

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

function setBadge(tabId: number, text: string): void {
  void browser.action.setBadgeText({ tabId, text });
  void browser.action.setBadgeBackgroundColor?.({ tabId, color: '#1c1c22' });
}

function clearBadge(tabId: number): void {
  void browser.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);
}
