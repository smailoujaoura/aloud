// Give every stylesheet and script a page links to a version from its contents
// (`assets/site.css?v=1a2b3c4d`). The site sits behind Cloudflare, which keeps CSS and JS for a
// week: without this, a deploy shipped new pages that still ran last week's styles and scripts.
// Run before deploying: `node scripts/stamp-website.mjs`.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const site = new URL('../website/', import.meta.url).pathname;
const version = (file) => createHash('sha256').update(readFileSync(join(site, file))).digest('hex').slice(0, 8);
for (const page of readdirSync(site).filter((f) => f.endsWith('.html'))) {
  const before = readFileSync(join(site, page), 'utf8');
  const after = before.replace(/((?:href|src)=")(assets\/[\w./-]+\.(?:css|js))(?:\?v=[0-9a-f]*)?"/g, (_, attr, file) => `${attr}${file}?v=${version(file)}"`);
  if (after !== before) {
    writeFileSync(join(site, page), after);
    console.log('stamped', page);
  }
}
