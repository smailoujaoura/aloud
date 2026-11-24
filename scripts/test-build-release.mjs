// The release for a test build (.github/workflows/test-build.yml): the zips `npm run zip` made,
// named for the tag, published as a pre-release with the changelog's section for its version as notes.
//
//   TAG=v1.0.5-rc.3 node scripts/test-build-release.mjs            (on GitHub, with GH_TOKEN)
//   TAG=v1.0.5-rc.3 DRY_RUN=1 node scripts/test-build-release.mjs  (says what it would publish)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const tag = process.env.TAG ?? '';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const match = /^v(\d+\.\d+\.\d+)-rc\.(\d+)$/.exec(tag);
if (!match) throw new Error(`"${tag}" is not a test build's tag (v${version}-rc.N)`);
// A tag for another version would publish this version's build under that name.
if (match[1] !== version) throw new Error(`${tag} is for ${match[1]}, but package.json says ${version}`);
const build = match[2];

const files = ['chrome', 'firefox'].map((browser) => {
  const made = `.output/tts-reader-${version}-${browser}.zip`;
  if (!existsSync(made)) throw new Error(`${made} is missing: run npm run zip first`);
  const named = `aloud-${version}-rc.${build}-${browser}.zip`;
  copyFileSync(made, named);
  return named;
});

// What changed, in the store notes' own words: the changelog's section for this version
// ("## 1.0.5 (unreleased: dated on release)"), not "Unreleased", which holds what waits for later.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const section = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b.*\\n([\\s\\S]*?)(?=^## )`, 'm');
const unreleased = section.exec(changelog)?.[1].trim() ?? '';
if (!unreleased) throw new Error(`CHANGELOG.md has no section for ${version}`);
const notes = [
  `Test build ${build} of Aloud ${version}, for trying on other devices before it goes to the stores.`,
  '',
  `- Firefox, including Firefox Nightly on a phone: install aloud-${version}-rc.${build}-firefox.zip from file, over the Aloud you have (removing it first deletes your voices).`,
  `- Chrome or Edge: unzip aloud-${version}-rc.${build}-chrome.zip, then Load unpacked, with any other Aloud turned off.`,
  '',
  '## In this version so far',
  '',
  unreleased,
].join('\n');
writeFileSync('release-notes.md', notes);

const args = ['release', 'create', tag, ...files, '--prerelease', '--title', `Aloud ${version}, test build ${build}`, '--notes-file', 'release-notes.md'];
if (process.env.DRY_RUN) {
  console.log(['gh', ...args].join(' '));
  console.log(`\n${notes.split('\n').slice(0, 12).join('\n')}\n…`);
} else {
  execFileSync('gh', args, { stdio: 'inherit' });
}
