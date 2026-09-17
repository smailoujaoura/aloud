/**
 * Content script for the media speed control — injected on demand by its shortcut (activeTab),
 * or registered for the sites listed in `mediaSpeed.alwaysOn` once those sites are granted.
 *
 * Idempotent: a second injection only reports what the first one is doing.
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { MediaSpeedController } from '@/media-speed/controller';
import { loadSiteSpeeds, rememberSiteSpeed, type SiteSpeeds } from '@/media-speed/site-speeds';
import { formatRate } from '@/media-speed/rate';
import { getSettings, watchSettings } from '@/shared/settings';
import { log } from '@/shared/log';

interface SpeedGlobal {
  __aloudSpeed?: MediaSpeedController;
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

export default defineUnlistedScript(() => {
  const w = window as unknown as SpeedGlobal;
  if (w.__aloudSpeed) {
    // Already running: say what the speed is, so the shortcut still gives an answer.
    const rate = w.__aloudSpeed.currentRate;
    if (rate != null) log.info(`[speed] already running at ${formatRate(rate)}`);
    return;
  }

  void (async () => {
    const settings = await getSettings().catch(() => null);
    if (!settings?.mediaSpeed.enabled) return;
    const host = siteHost();
    const sites: SiteSpeeds = settings.mediaSpeed.rememberPerSite
      ? await loadSiteSpeeds().catch(() => ({}) as SiteSpeeds)
      : {};
    const remembered = sites[host]?.rate ?? null;
    const startAt = settings.mediaSpeed.startAt > 0 ? settings.mediaSpeed.startAt : null;

    let settingsNow = settings.mediaSpeed;
    const controller = new MediaSpeedController({
      settings: settings.mediaSpeed,
      initialRate: remembered ?? startAt,
      // Only the top frame remembers: an embedded player would otherwise store its own host.
      onRate: (rate) => {
        if (settingsNow.rememberPerSite && window.top === window) void rememberSiteSpeed(host, rate);
      },
    });
    w.__aloudSpeed = controller;
    controller.start();
    if (remembered != null || startAt != null) controller.setRate(remembered ?? startAt!, remembered != null);
    log.info(`[speed] controlling ${controller.mediaCount} media element(s) on ${host}`);

    watchSettings((next) => {
      settingsNow = next.mediaSpeed;
      controller.setSettings(next.mediaSpeed);
      if (!next.mediaSpeed.enabled) {
        controller.stop();
        w.__aloudSpeed = undefined;
      }
    });
  })().catch((err) => log.warn('[speed] could not start:', err));
});
