// The Safari app's icons, drawn from the extension's own (public/icon/icon.svg) at every size.
//
//   node scripts/safari-icons.mjs
//
// Apple's converter makes them by enlarging the 128-pixel PNG, which is a blur at 1024, the size
// the App Store shows. Here each size is drawn from the vector instead:
//  - iPhone and iPad: one 1024-pixel square, edge to edge and with no transparency (the system
//    cuts the corners itself, and the App Store refuses an icon with an alpha channel).
//  - Mac: the rounded square inside a margin, as Mac icons are (824 of 1024), transparent around it.
// Run it again after the icon changes; the files are committed with the Xcode project (safari/).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'safari/Aloud/Shared (App)/Assets.xcassets');
const set = join(assets, 'AppIcon.appiconset');
if (!existsSync(set)) throw new Error('No Xcode project yet: see docs/SAFARI.md ("Build on the Mac").');

const source = readFileSync(join(root, 'public/icon/icon.svg'), 'utf8');
// The drawing without its own rounded background: the speaker and its sound wave.
const glyph = source.replace(/<svg[^>]*>/, '').replace('</svg>', '').replace(/<rect[^>]*\/>/, '');
const background = /<rect[^>]*fill="(#[0-9a-f]{6})"/i.exec(source)?.[1];
if (!background || !/<path/.test(glyph)) throw new Error('public/icon/icon.svg is not the shape this script knows');

/** Edge to edge: the system rounds it. */
const phone = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${background}"/>${glyph}</svg>`;
/** A Mac icon: the rounded square is 824 of the 1024 canvas, with a soft shadow under it. */
const mac = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="s" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-opacity="0.3"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${background}" filter="url(#s)"/>
  <g transform="translate(100 100) scale(${824 / 96})">${glyph}</g>
</svg>`;

const draw = (svg, size) => sharp(Buffer.from(svg), { density: (72 * size) / 96 }).resize(size, size);

const contents = JSON.parse(readFileSync(join(set, 'Contents.json'), 'utf8'));
const written = new Set();
for (const image of contents.images) {
  if (!image.filename || written.has(image.filename)) continue;
  written.add(image.filename);
  const points = Number(String(image.size).split('x')[0]);
  const size = points * Number(String(image.scale ?? '1x').replace('x', ''));
  const png =
    image.platform === 'ios' || image.idiom === 'universal'
      ? await draw(phone, size).flatten({ background }).removeAlpha().png().toBuffer()
      : await draw(mac, size).png().toBuffer();
  writeFileSync(join(set, image.filename), png);
}

// The picture the app's own window shows, and the one in its "turn the extension on" page.
const large = await draw(source, 256).png().toBuffer();
for (const file of [join(assets, 'LargeIcon.imageset/128.png'), join(root, 'safari/Aloud/Shared (App)/Resources/Icon.png')]) {
  if (existsSync(file)) writeFileSync(file, large);
}
console.log(`[safari-icons] ${written.size} app icon sizes drawn from public/icon/icon.svg`);
