/**
 * Aloud's own website, for the few things better explained on a page than in a sentence.
 * The pages live in website/ (tests/site-links.test.ts checks they exist).
 */
export const SITE_URL = 'https://aloud.souj.dev';

/** Why the voice runs faster on a graphics card, why turning WebGPU on is safe, and how. */
export const GPU_GUIDE_URL = `${SITE_URL}/gpu.html`;

/** Bug reports and ideas; also the page the browser opens when Aloud is removed. */
export const FEEDBACK_URL = `${SITE_URL}/feedback.html`;

/**
 * The feedback page. Aloud's version and browser ride in the fragment (after `#`), which a browser
 * never sends to a server: the page reads them to start a bug report with them, and the website
 * receives nothing. So opening it, even automatically on uninstall, transmits no data. `uninstall`
 * asks why Aloud was removed (website/feedback.html reads `bye`).
 */
export function feedbackLink(version: string, browserName: string, uninstall = false): string {
  const info = new URLSearchParams({ v: version, b: browserName });
  return `${FEEDBACK_URL}${uninstall ? '?bye' : ''}#${info}`;
}
