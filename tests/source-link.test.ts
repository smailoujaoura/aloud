/**
 * The GPL asks that every copy say where its source is. The address appears in package.json
 * (read by scripts/notices.mjs), in Settings and on the website: they must not drift apart.
 */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('every "Source code" link points at the repository package.json names', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const url = pkg.repository.url as string;
  for (const file of ['src/entrypoints/options/index.html', 'website/index.html']) {
    const links = [...readFileSync(file, 'utf8').matchAll(/class="source-link" href="([^"]+)"/g)].map((m) => m[1]);
    expect(links.length, file).toBeGreaterThan(0);
    for (const href of links) expect(href, file).toBe(url);
  }
});
