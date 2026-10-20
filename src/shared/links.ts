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
 * The feedback page, carrying Aloud's version and browser so a bug report starts with them, and
 * nothing else. `uninstall` asks why Aloud was removed (website/feedback.html reads `bye`).
 */
export function feedbackLink(version: string, browserName: string, uninstall = false): string {
  const q = new URLSearchParams(uninstall ? { bye: '', v: version, b: browserName } : { v: version, b: browserName });
  return `${FEEDBACK_URL}?${q}`;
}
