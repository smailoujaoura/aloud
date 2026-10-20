/** Links from the extension to Aloud's website point at pages the website actually has. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { FEEDBACK_URL, GPU_GUIDE_URL, SITE_URL, feedbackLink } from '@/shared/links';

it('the graphics-card guide exists, and Settings links to the same address', () => {
  expect(GPU_GUIDE_URL.startsWith(SITE_URL)).toBe(true);
  expect(existsSync(`website${GPU_GUIDE_URL.slice(SITE_URL.length)}`)).toBe(true);
  const options = readFileSync('src/entrypoints/options/index.html', 'utf8');
  const links = [...options.matchAll(/class="gpu-guide" href="([^"]+)"/g)].map((m) => m[1]);
  expect(links).toEqual([GPU_GUIDE_URL]);
  // The website links to it too.
  expect(readFileSync('website/index.html', 'utf8')).toContain('href="gpu.html"');
});

it('the feedback page exists, and the uninstall address carries only the version and the browser', () => {
  expect(existsSync(`website${FEEDBACK_URL.slice(SITE_URL.length)}`)).toBe(true);
  const bye = new URL(feedbackLink('1.0.0', 'firefox', true));
  expect([...bye.searchParams.keys()]).toEqual(['bye', 'v', 'b']);
  expect(bye.href.length).toBeLessThan(1023); // runtime.setUninstallURL's limit
  expect(new URL(feedbackLink('1.0.0', 'chrome')).searchParams.has('bye')).toBe(false);
  // Every page of the website links to it.
  for (const page of ['index', 'tour', 'built', 'gpu', 'privacy']) {
    expect(readFileSync(`website/${page}.html`, 'utf8')).toContain('href="feedback.html"');
  }
});
