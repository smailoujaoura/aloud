/**
 * Content script for the media speed control — injected on demand by its shortcut (activeTab),
 * or registered for the sites listed in `mediaSpeed.alwaysOn` once those sites are granted. The
 * registered one runs as the page starts, so the autoplay guard is there before the video is.
 *
 * Idempotent: a second injection only reports what the first one is doing.
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { MediaSpeedController } from '@/media-speed/controller';
import { AutoplayGuard } from '@/media-speed/autoplay';
import { loadSiteSpeeds, rememberSiteSpeed, type SiteSpeeds } from '@/media-speed/site-speeds';
import { formatRate } from '@/media-speed/rate';
import { formatBinding } from '@/media-speed/keys';
import { getSettings, watchSettings } from '@/shared/settings';
import { log } from '@/shared/log';
import { capabilities } from '@/shared/browser-env';

interface SpeedGlobal {
  __aloudSpeed?: MediaSpeedController;
  /** Alt+M on a page where the control runs: it stops here, saying `text` (background.ts). */
  __aloudSpeedOff?: (text: string) => void;
}

/** The site this frame belongs to: for an embedded player, the page it is embedded in. */
function siteHost(): string {
  try {
    const origins = location.ancestorOrigins;
    const top = origins && origins.length > 0 ? origins[origins.length - 1] : null;
    return (top ? new URL(top).hostname : location.hostname).replace(/^www\./, '');
  } catch {
    return location.hostname.replace(/^www\./, '');
  }
}

/** A touch screen and no mouse or touchpad: a phone or tablet, whatever its browser says it is. */
function touchOnly(): boolean {
  try {
    return matchMedia('(any-pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

export default defineUnlistedScript(() => {
  const w = window as unknown as SpeedGlobal;
  if (w.__aloudSpeed) {
    // Already running: say what the speed is, so the shortcut still gives an answer.
    const rate = w.__aloudSpeed.currentRate;
    if (rate != null) log.info(`[speed] already running at ${formatRate(rate)}`);
    return;
  }

  // Started with the page (registered) or on a page already open (the shortcut)? Only in the first
  // case is a video that is already playing one that started by itself.
  const withThePage = document.readyState === 'loading';
  let controller: MediaSpeedController | null = null;
  const guard = new AutoplayGuard({
    enabled: false, // until the settings say otherwise
    leavePlaying: !withThePage,
    notice: (media) => controller?.notice('Autoplay stopped. Press play to watch', media),
  });
  // Clicks and keys from the very start: one made while the settings load still counts.
  const stopWatching = guard.watchGestures();

  void (async () => {
    const settings = await getSettings().catch(() => null);
    if (!settings?.mediaSpeed.enabled) {
      stopWatching();
      return;
    }
    const host = siteHost();
    // Not on this site (Settings: "Not on these sites"), unless asked for with the shortcut. The
    // registration leaves those sites out already; a frame from another site is caught here.
    const never = settings.mediaSpeed.neverOn.some((site) => host === site || host.endsWith(`.${site}`));
    if (never && withThePage) {
      stopWatching();
      return;
    }
    guard.enabled = settings.mediaSpeed.blockAutoplay;
    const sites: SiteSpeeds = settings.mediaSpeed.rememberPerSite
      ? await loadSiteSpeeds().catch(() => ({}) as SiteSpeeds)
      : {};
    const remembered = sites[host]?.rate ?? null;
    const startAt = settings.mediaSpeed.startAt > 0 ? settings.mediaSpeed.startAt : null;

    let settingsNow = settings.mediaSpeed;
    controller = new MediaSpeedController({
      settings: settings.mediaSpeed,
      onMedia: (media) => guard.track(media),
      initialRate: remembered ?? startAt,
      // A phone has no keys: a speed button on the video instead. A phone asking for a site's
      // desktop version says it is a computer, and was left with keys it has no way to press.
      touchButton: capabilities().touchFirst || touchOnly(),
      // Only the top frame remembers: an embedded player would otherwise store its own host.
      onRate: (rate) => {
        if (settingsNow.rememberPerSite && window.top === window) void rememberSiteSpeed(host, rate);
      },
    });
    w.__aloudSpeed = controller;
    w.__aloudSpeedOff = (text) => {
      stopWatching();
      guard.enabled = false;
      controller?.stop(window.top === window ? text : undefined);
      w.__aloudSpeed = undefined;
      w.__aloudSpeedOff = undefined;
    };
    controller.start();
    guard.settle();
    // Turned on with its key (Alt+M): say so, and how it works, even on a page with no video yet.
    if (!withThePage && window.top === window) {
      const k = settings.mediaSpeed.keys;
      controller.notice(`Video speed on: ${formatBinding(k.faster)} faster, ${formatBinding(k.slower)} slower, ${formatBinding(k.reset)} normal`);
    }
    if (remembered != null || startAt != null) controller.setInitialRate(remembered ?? startAt!, remembered != null);
    log.info(`[speed] controlling ${controller.mediaCount} media element(s) on ${host}`);

    watchSettings((next) => {
      settingsNow = next.mediaSpeed;
      controller!.setSettings(next.mediaSpeed);
      guard.enabled = next.mediaSpeed.enabled && next.mediaSpeed.blockAutoplay;
      if (!next.mediaSpeed.enabled) {
        stopWatching();
        controller!.stop();
        w.__aloudSpeed = undefined;
        w.__aloudSpeedOff = undefined;
      }
    });
  })().catch((err) => log.warn('[speed] could not start:', err));
});
