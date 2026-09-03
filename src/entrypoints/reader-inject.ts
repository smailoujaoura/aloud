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

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; mode?: ActivateMode; targetElementId?: number };
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
