// Writes public/licenses/: Aloud's own licence and the licence texts of everything it ships.
//
// Aloud is GPL-3.0-or-later because it includes eSpeak-NG (GPLv3), and it includes lamejs (LGPL).
// Both licences require that a copy of the program carry its licence and say where the source
// is — and the stores' packages carried neither: the bundles had lost the libraries' copyright
// comments, and the notices lived only in the repository. This puts them in the package, from
// each production dependency's own LICENSE / NOTICE / COPYING files, with the source address
// from package.json's `repository`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the Safari package's notices are written (wxt.config.ts reads this). */
export const SAFARI_NOTICES_DIR = '.gen/licenses-safari';

/** Every package in the production dependency tree, by its directory. */
function productionPackages() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' });
  return [...new Set(out.split('\n').map((l) => l.trim()).filter((l) => l && l !== root))].sort((a, b) =>
    relative(root, a).localeCompare(relative(root, b)),
  );
}

// Also LICENSE-MIT / LICENSE-APACHE (dual-licensed packages such as phonon-tts) and THIRD_PARTY_LICENSES.md.
const LICENSE_FILE = /^(licen[cs]e|copying|notice|third[-_]party[-_]licen[cs]es)([-_][a-z0-9.-]+)?(\.(md|txt|markdown))?$/i;

/**
 * What only Piper and Kokoro need. Both read through eSpeak-NG (GPL-3.0), which the App Store's
 * terms do not allow, so the Safari package has neither (docs/SAFARI.md), and its notices must not
 * say it has: a notice naming eSpeak-NG in a package without it tells Apple's reviewer, and the
 * reader, something untrue.
 */
const ESPEAK_ONLY = ['@diffusionstudio/piper-wasm', '@huggingface/transformers', 'kokoro-js', 'phonemizer'];

/** The lockfile keys of every package reachable from `roots`, resolved as Node resolves them. */
function reachable(locked, roots) {
  const find = (from, name) => {
    for (let at = from; ; at = at.includes('/node_modules/') ? at.slice(0, at.lastIndexOf('/node_modules/')) : '') {
      const key = `${at ? `${at}/` : ''}node_modules/${name}`;
      if (locked[key]) return key;
      if (!at) return null;
    }
  };
  const seen = new Set();
  const walk = (from, names) => {
    for (const name of names) {
      const key = find(from, name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      walk(key, Object.keys({ ...locked[key].dependencies, ...locked[key].optionalDependencies }));
    }
  };
  walk('', roots);
  return seen;
}

/**
 * Writes the notices for the Firefox and Chromium packages into public/licenses/. With
 * `browser: 'safari'`, also the Safari package's own, into .gen/licenses-safari/ (wxt.config.ts
 * puts it in that package in place of the other): the same, without what Safari leaves out.
 */
export function writeNotices({ browser } = {}) {
  write({});
  if (browser === 'safari') write({ safari: true });
}

function write({ safari = false }) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!source) throw new Error('package.json has no "repository": the notices must say where the source is');

  // What the lockfile calls optional: installed or not depending on the machine (see below).
  const locked = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages ?? {};
  const keyOf = (dir) => relative(root, dir).split('\\').join('/');
  const optional = (dir) => locked[keyOf(dir)]?.optional === true;
  // Safari: only what its package is built from.
  const inSafari = safari ? reachable(locked, Object.keys(pkg.dependencies ?? {}).filter((name) => !ESPEAK_ONLY.includes(name))) : null;

  const sections = [];
  for (const dir of productionPackages()) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name, version, license, cpu } = JSON.parse(readFileSync(manifest, 'utf8'));
    // A native binary for one processor (sharp's libvips, pdf.js's Node canvas): Node-only, never in
    // the extension, and installed or not depending on the machine, which made the notices, and so
    // the package, differ from one clean build to the next (a reviewer's rebuild among them).
    // The same for every optional package, and what only they need: npm on Linux installed tslib 2
    // for sharp's WebAssembly fallback and npm on a Mac did not, so a package built on one had 18
    // lines of notices that a rebuild on the other lacked. (pdf-lib's own tslib is not optional,
    // is in the extension, and stays listed.)
    if (cpu || optional(dir)) continue;
    if (inSafari && !inSafari.has(keyOf(dir))) continue;
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
    const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim());
    sections.push(
      [`${'='.repeat(78)}`, `${name} ${version}${license ? ` — ${typeof license === 'string' ? license : JSON.stringify(license)}` : ''}`, `${'='.repeat(78)}`, '', texts.length ? texts.join('\n\n') : '(no licence file in the package; see its "license" field above)']
        .join('\n'),
    );
  }

  // Files copied into the extension rather than installed as packages: their licence travels with them.
  const COPIED = [{ name: 'flag-icons (the language flags, public/flags/)', version: '7.5.0', license: 'MIT', file: 'public/flags/LICENSE.txt' }];
  for (const c of COPIED) {
    sections.push(
      [`${'='.repeat(78)}`, `${c.name} ${c.version} — ${c.license}`, `${'='.repeat(78)}`, '', readFileSync(join(root, c.file), 'utf8').trim()].join('\n'),
    );
  }

  const header = safari
    ? `Aloud ${pkg.version} for Safari — third-party notices

Aloud's own code is distributed under the licence in LICENSE.txt beside this file. This edition,
for Safari, has no eSpeak-NG in it, and so none of the voices that read through it (Piper and
Kokoro, which Aloud for Firefox and for Chrome have): its voices are Phonon and Supertonic, and a
speech server of your own. It includes lamejs (LGPL-3.0, full text in LGPL-3.0.txt beside this
file) for MP3 export.

The complete corresponding source code is available at:
  ${source}

Below are the licences and notices of the open-source packages this edition is built from, as
each package states them. Voice models are not part of this package; they are downloaded on first
use from Hugging Face, each under its own licence: see THIRD_PARTY.md in the source repository.
`
    : `Aloud ${pkg.version} — third-party notices

Aloud is free software, distributed under the GNU General Public License, version 3 or (at your
option) any later version: see LICENSE.txt beside this file. It is GPL because it includes
eSpeak-NG (GPL-3.0-or-later), compiled to WebAssembly, as the phonemizer for its voices. It also
includes lamejs (LGPL-3.0, full text in LGPL-3.0.txt beside this file) for MP3 export.

The complete corresponding source code is available at:
  ${source}

Below are the licences and notices of the open-source packages Aloud is built from, as each
package states them. Voice models are not part of this package; they are downloaded on first use
from Hugging Face, each under its own licence: see THIRD_PARTY.md, and for every Piper voice
PIPER_VOICE_LICENCES.md, in the source repository.
`;
  // Components compiled into other packages, with no package.json of their own to read from.
  const espeak = (section) => (safari ? [] : [section]);
  sections.unshift(
    ...espeak([
      '='.repeat(78),
      'eSpeak NG — GPL-3.0-or-later',
      '='.repeat(78),
      '',
      'Compiled to WebAssembly inside piper_phonemize (rhasspy fork, every language) and inside the',
      '"phonemizer" package (English data), as the text-to-phoneme engine for the voices.',
      'Copyright Jonathan Duddington, Reece H. Dunn, and the eSpeak NG contributors.',
      'Source: https://github.com/espeak-ng/espeak-ng and https://github.com/rhasspy/espeak-ng',
      'Licence: GNU General Public License v3 or later — the full text is LICENSE.txt beside this file.',
    ].join('\n')),
    [
      '='.repeat(78),
      'Voice preview sentences — CC BY-SA 4.0',
      '='.repeat(78),
      '',
      'The sentence a voice says when previewed is, in 39 languages, a sentence from',
      'the Wikipedia article on the rainbow in that language (as Piper collects them for its voice',
      'samples), by Wikipedia contributors, under the Creative Commons Attribution-ShareAlike 4.0',
      'licence: https://creativecommons.org/licenses/by-sa/4.0/',
      'Polish, Chinese, Estonian and Swedish say a translation of Aloud\'s own English sample sentence.',
    ].join('\n'),
    [
      '='.repeat(78),
      'Voice portraits',
      '='.repeat(78),
      '',
      'The faces beside some voices are generated images of people who do not exist, made for Aloud',
      'with SDXL and the SDXL-Lightning UNet (both under the CreativeML OpenRAIL++-M licence).',
    ].join('\n'),
    ...espeak([
      '='.repeat(78),
      'piper-phonemize — MIT',
      '='.repeat(78),
      '',
      'Copyright (c) 2023 Michael Hansen. Compiled to WebAssembly in @diffusionstudio/piper-wasm.',
      'Source: https://github.com/rhasspy/piper-phonemize',
    ].join('\n')),
  );
  const outDir = join(root, safari ? SAFARI_NOTICES_DIR : 'public/licenses');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), `${header}\n${sections.join('\n\n\n')}\n`);
  if (safari) {
    console.log(`[notices] ${sections.length} packages → ${SAFARI_NOTICES_DIR}/ (Safari: nothing of eSpeak-NG)`);
    return;
  }
  writeFileSync(join(outDir, 'LICENSE.txt'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  // lamejs ships LAME's FAQ as its LICENSE file, not the licence: the LGPL text itself goes along.
  writeFileSync(join(outDir, 'LGPL-3.0.txt'), readFileSync(join(root, 'scripts/licenses/LGPL-3.0.txt'), 'utf8'));
  console.log(`[notices] ${sections.length} packages → public/licenses/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeNotices({ browser: process.argv[2] });
