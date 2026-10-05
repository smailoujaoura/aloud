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

/** Every package in the production dependency tree, by its directory. */
function productionPackages() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' });
  return [...new Set(out.split('\n').map((l) => l.trim()).filter((l) => l && l !== root))].sort((a, b) =>
    relative(root, a).localeCompare(relative(root, b)),
  );
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

export function writeNotices() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!source) throw new Error('package.json has no "repository": the notices must say where the source is');

  const sections = [];
  for (const dir of productionPackages()) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name, version, license } = JSON.parse(readFileSync(manifest, 'utf8'));
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
    const texts = files.map((f) => readFileSync(join(dir, f), 'utf8').trim());
    sections.push(
      [`${'='.repeat(78)}`, `${name} ${version}${license ? ` — ${typeof license === 'string' ? license : JSON.stringify(license)}` : ''}`, `${'='.repeat(78)}`, '', texts.length ? texts.join('\n\n') : '(no licence file in the package; see its "license" field above)']
        .join('\n'),
    );
  }

  const header = `Aloud ${pkg.version} — third-party notices

Aloud is free software, distributed under the GNU General Public License, version 3 or (at your
option) any later version: see LICENSE.txt beside this file. It is GPL because it includes
eSpeak-NG (GPL-3.0-or-later), compiled to WebAssembly, as the phonemizer for its voices. It also
includes lamejs (LGPL-3.0, full text in LGPL-3.0.txt beside this file) for MP3 export.

The complete corresponding source code is available at:
  ${source}

Below are the licences and notices of the open-source packages Aloud is built from, as each
package states them. Voice models are not part of this package; they are downloaded on first use
from Hugging Face, each under its own licence (see the repository's THIRD_PARTY.md).
`;
  // Components compiled into other packages, with no package.json of their own to read from.
  sections.unshift(
    [
      '='.repeat(78),
      'eSpeak NG — GPL-3.0-or-later',
      '='.repeat(78),
      '',
      'Compiled to WebAssembly inside piper_phonemize (rhasspy fork, every language) and inside the',
      '"phonemizer" package (English data), as the text-to-phoneme engine for the voices.',
      'Copyright Jonathan Duddington, Reece H. Dunn, and the eSpeak NG contributors.',
      'Source: https://github.com/espeak-ng/espeak-ng and https://github.com/rhasspy/espeak-ng',
      'Licence: GNU General Public License v3 or later — the full text is LICENSE.txt beside this file.',
    ].join('\n'),
    [
      '='.repeat(78),
      'piper-phonemize — MIT',
      '='.repeat(78),
      '',
      'Copyright (c) 2023 Michael Hansen. Compiled to WebAssembly in @diffusionstudio/piper-wasm.',
      'Source: https://github.com/rhasspy/piper-phonemize',
    ].join('\n'),
  );
  const outDir = join(root, 'public/licenses');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), `${header}\n${sections.join('\n\n\n')}\n`);
  writeFileSync(join(outDir, 'LICENSE.txt'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  // lamejs ships LAME's FAQ as its LICENSE file, not the licence: the LGPL text itself goes along.
  writeFileSync(join(outDir, 'LGPL-3.0.txt'), readFileSync(join(root, 'scripts/licenses/LGPL-3.0.txt'), 'utf8'));
  console.log(`[notices] ${sections.length} packages → public/licenses/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeNotices();
