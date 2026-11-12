/**
 * pdf.js's modern build, run as an older browser would run it: every built-in that
 * public/pdfjs-support/polyfills.mjs supplies is deleted first, then the polyfills are installed,
 * then pdf.js reads each PDF given. Prints {file: text} and the polyfills installed, as JSON.
 * Run by tests/pdfjs-modern-build.test.ts in a process of its own, so nothing else sees the
 * deleted built-ins.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
const gone = [
  [Math, 'sumPrecise'],
  [Map.prototype, 'getOrInsert'],
  [Map.prototype, 'getOrInsertComputed'],
  [WeakMap.prototype, 'getOrInsert'],
  [WeakMap.prototype, 'getOrInsertComputed'],
  [Uint8Array.prototype, 'toBase64'],
  [Uint8Array.prototype, 'toHex'],
  [Uint8Array, 'fromBase64'],
  [Blob.prototype, 'bytes'],
  [Response.prototype, 'bytes'],
  [Promise, 'try'],
  [URL, 'parse'],
  ...['map', 'filter', 'flatMap', 'take', 'drop', 'toArray', 'forEach', 'some', 'every', 'find', 'reduce', 'join'].map((n) => [iteratorPrototype, n]),
  ...['intersection', 'union', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'].map((n) => [Set.prototype, n]),
];
for (const [target, name] of gone) delete target[name];
// Chrome 120 and 121 have no Iterator global at all, and pdf.js reads Iterator.prototype as it loads.
delete globalThis.Iterator;

const root = new URL('../../', import.meta.url);
const { install } = await import(new URL('public/pdfjs-support/polyfills.mjs', root).href);
const pdfjs = await import(new URL('node_modules/pdfjs-dist/build/pdf.mjs', root).href);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('node_modules/pdfjs-dist/build/pdf.worker.mjs', root).href;

const out = {};
for (const file of process.argv.slice(2)) {
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join('|'));
  }
  await task.destroy();
  out[file] = pages.join('\n');
}
const missing = gone.filter(([target, name]) => typeof target[name] !== 'function').map(([, name]) => name);
if (typeof globalThis.Iterator !== 'function') missing.push('Iterator');
console.log(JSON.stringify({ out, missing }));
