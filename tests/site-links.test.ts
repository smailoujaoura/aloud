/** Links from the extension to Aloud's website point at pages the website actually has. */
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { GPU_GUIDE_URL, SITE_URL } from '@/shared/links';

it('the graphics-card guide exists, and Settings links to the same address', () => {
  expect(GPU_GUIDE_URL.startsWith(SITE_URL)).toBe(true);
  expect(existsSync(`website${GPU_GUIDE_URL.slice(SITE_URL.length)}`)).toBe(true);
  const options = readFileSync('src/entrypoints/options/index.html', 'utf8');
  const links = [...options.matchAll(/class="gpu-guide" href="([^"]+)"/g)].map((m) => m[1]);
  expect(links).toEqual([GPU_GUIDE_URL]);
  // The website links to it too.
  expect(readFileSync('website/index.html', 'utf8')).toContain('href="gpu.html"');
});
