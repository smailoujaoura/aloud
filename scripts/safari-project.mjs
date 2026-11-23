// Keeps the Safari app's Xcode project (safari/, see docs/SAFARI.md) in step with the build.
//
//   node scripts/safari-project.mjs        (run by `npm run build:safari`)
//
//  - The app and its extension carry the extension's version (package.json), which is what the App
//    Store and Safari's Extensions list show.
//  - The project names each top-level file and folder of .output/safari-mv3 it packs. One the build
//    has since gained would be left out of the app without a word, and one it lost would stop
//    Xcode's build: both are said here, by name.
// Does nothing when there is no project yet (it is made once, on a Mac).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'safari/Aloud/Aloud.xcodeproj/project.xcproj');
const built = join(root, '.output/safari-mv3');

if (!existsSync(file)) {
  console.log('[safari-project] no Xcode project yet (docs/SAFARI.md, "Build on the Mac"): nothing to update');
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const before = readFileSync(file, 'utf8');
const after = before.replace(/("MARKETING_VERSION":\s*")[^"]*(")/g, `$1${version}$2`);
if (!/"MARKETING_VERSION"/.test(after)) throw new Error('safari/…/project.xcproj has no MARKETING_VERSION: has Xcode changed its format?');
if (after !== before) writeFileSync(file, after);
console.log(`[safari-project] version ${version}${after === before ? ' (already set)' : ''}`);

if (existsSync(built)) {
  const packed = new Set([...after.matchAll(/\.output\/safari-mv3\/([^"/]+)"/g)].map((m) => m[1]));
  const there = readdirSync(built).filter((name) => !name.startsWith('.'));
  const missing = there.filter((name) => !packed.has(name));
  const gone = [...packed].filter((name) => !there.includes(name));
  if (missing.length || gone.length) {
    if (missing.length) console.error(`[safari-project] in the build but not in the Xcode project (add them to "Shared (Extension)/Resources"): ${missing.join(', ')}`);
    if (gone.length) console.error(`[safari-project] in the Xcode project but no longer built (remove them there): ${gone.join(', ')}`);
    process.exit(1);
  }
  console.log(`[safari-project] the project packs all ${there.length} top-level entries of the build`);
}
