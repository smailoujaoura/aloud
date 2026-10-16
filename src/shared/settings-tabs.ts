/**
 * Where the toolbar button opens settings, on a page Aloud cannot read.
 *
 * Over the page itself when nothing is lost by it: a page that is only somewhere to start from
 * (a new tab, about:blank), or one of the browser's own pages (about:preferences,
 * about:debugging, chrome://extensions), which Back brings straight back. Anything else — an
 * add-on store, a local file without access, an address hidden from Aloud — is someone's page,
 * and settings open beside it.
 */

/** Pages that are only somewhere to start from. */
const EMPTY_PAGE =
  /^(about:(newtab|home|blank|privatebrowsing)|chrome:\/\/(newtab|new-tab-page)\/?|edge:\/\/newtab\/?|chrome-search:\/\/local-ntp|chrome:\/\/vivaldi-webui\/startpage)/i;

/** The browser's own pages: settings, add-ons, debugging, history and the like. */
const BROWSER_PAGE = /^(about:|chrome:\/\/|edge:\/\/|brave:\/\/|opera:\/\/|vivaldi:\/\/)/i;

/**
 * A page that is only somewhere to start from. Firefox lets the reader into about:blank, which
 * then said "This page doesn't look like an article" — the button opens settings there instead.
 */
export function emptyPage(url: string | undefined): boolean {
  return !!url && EMPTY_PAGE.test(url);
}

/** Should settings open in this tab (true), or beside it (false)? Unknown addresses: beside. */
export function settingsReplace(url: string | undefined): boolean {
  if (!url) return false;
  return EMPTY_PAGE.test(url) || BROWSER_PAGE.test(url);
}
