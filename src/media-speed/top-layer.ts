/**
 * Showing something above a video in full screen.
 *
 * In full screen the browser draws only the full-screen element and what is inside it, so an
 * element anywhere else in the page is hidden however high its z-index (a Loom video on Skool,
 * YouTube, any site). A popover is drawn in the top layer, where the full-screen element is, and
 * above it when opened after it: so it is closed and opened again each time it shows, to come out
 * on top. Without popovers, it moves into the full-screen element when that can hold it (a
 * player's box, not a <video>).
 */

/** Can elements be shown in the top layer here (the Popover API: Chrome 114, Firefox 125)? */
export const POPOVERS = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

/**
 * Style for a host that may be a popover: the browser's own popover look (inset 0, a border, a
 * background, a scroll box) undone. Position it with top and left.
 */
export const TOP_LAYER_HOST_STYLE =
  'position:fixed;z-index:2147483646;display:none;inset:auto;margin:0;padding:0;border:0;' +
  'background:transparent;overflow:visible;width:auto;height:auto;';

/** Make `host` able to go in the top layer. */
export function topLayerHost(host: HTMLElement): void {
  if (POPOVERS) host.setAttribute('popover', 'manual');
}

/** Show `host` above everything, a video in full screen included. */
export function raise(host: HTMLElement): void {
  if (POPOVERS && host.isConnected) {
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
      return;
    } catch {
      /* not shown as a popover: the fallback below */
    }
  }
  const full = document.fullscreenElement;
  const into = full && !(full instanceof HTMLMediaElement) ? full : document.body ?? document.documentElement;
  if (into && host.parentElement !== into) into.append(host);
}

export function lower(host: HTMLElement): void {
  if (!POPOVERS) return;
  try {
    if (host.matches(':popover-open')) host.hidePopover();
  } catch {
    /* already gone */
  }
}
