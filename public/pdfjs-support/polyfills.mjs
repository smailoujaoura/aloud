/**
 * Built-ins that pdf.js's modern build calls and that a browser Aloud supports may not have yet.
 *
 * Aloud ships pdf.js's modern build exactly as Mozilla publishes it. Its legacy build, shipped until
 * 1.0.3, brings core-js for these, and the Chrome Web Store rejected core-js as obfuscated code
 * ("Red Titanium": one of its fallbacks for very old engines builds a script address from pieces,
 * for an iframe). These are
 * plain versions of only what pdf.js calls, each installed only where the browser lacks it. For the
 * browsers Aloud supports (Chrome 120 and later, Firefox 142 and later):
 *
 *   Iterator.prototype.join                        no browser yet (pdf.js: XFA forms)
 *   Math.sumPrecise                                Chrome 147
 *   Map, WeakMap: getOrInsert, getOrInsertComputed Chrome 145, Firefox 144
 *   Blob.prototype.bytes                           Chrome 144
 *   Uint8Array: toBase64, fromBase64, toHex        Chrome 140
 *   Response.prototype.bytes                       Chrome 132
 *   Promise.try                                    Chrome 128
 *   URL.parse                                      Chrome 126
 *   Iterator helpers (map, filter, some, find…)    Chrome 122
 *   Set: intersection, union and the rest          Chrome 122
 *
 * Loaded before pdf.mjs on the page (src/pdf/load-pdf.ts) and before pdf.worker.mjs in its worker
 * (worker.mjs, beside this file). The list is what pdf.js's legacy build adds over the modern one,
 * checked for each pdfjs-dist update (BUILD.md).
 */

/** Exact sum of numbers, rounded once (Shewchuk's algorithm, as Python's math.fsum). */
export function sumPrecise(items) {
  const partials = []; // non-overlapping, smallest magnitude first
  let special = 0; // the sum of any infinities and NaN
  let count = 0;
  let allNegativeZero = true;
  for (const x of items) {
    if (typeof x !== 'number') throw new TypeError('Math.sumPrecise: every item must be a number');
    count++;
    if (!Number.isFinite(x)) {
      special += x;
      continue;
    }
    if (!Object.is(x, -0)) allNegativeZero = false;
    let value = x;
    let kept = 0;
    for (let partial of partials) {
      if (Math.abs(value) < Math.abs(partial)) [value, partial] = [partial, value];
      const high = value + partial;
      const low = partial - (high - value);
      if (low !== 0) partials[kept++] = low;
      value = high;
    }
    partials.length = kept;
    partials.push(value);
  }
  if (special !== 0) return special; // Infinity, -Infinity or NaN
  if (count === 0 || allNegativeZero) return -0;
  let n = partials.length - 1;
  let high = partials[n];
  let low = 0;
  while (n > 0) {
    const before = high;
    const next = partials[--n];
    high = before + next;
    low = next - (high - before);
    if (low !== 0) break;
  }
  // Half-way between two doubles: round to even, looking at what is left below.
  if (n > 0 && ((low < 0 && partials[n - 1] < 0) || (low > 0 && partials[n - 1] > 0))) {
    const twice = low * 2;
    const rounded = high + twice;
    if (twice === rounded - high) high = rounded;
  }
  return high;
}

export function getOrInsert(key, value) {
  if (!this.has(key)) this.set(key, value);
  return this.get(key);
}

export function getOrInsertComputed(key, compute) {
  if (typeof compute !== 'function') throw new TypeError('getOrInsertComputed: not a function');
  if (!this.has(key)) this.set(key, compute(key));
  return this.get(key);
}

export function toBase64(options = {}) {
  let binary = '';
  for (let i = 0; i < this.length; i += 0x8000) binary += String.fromCharCode(...this.subarray(i, i + 0x8000));
  let text = btoa(binary);
  if (options.alphabet === 'base64url') text = text.replace(/\+/g, '-').replace(/\//g, '_');
  if (options.omitPadding) text = text.replace(/=+$/, '');
  return text;
}

export function fromBase64(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Uint8Array.fromBase64: not a string');
  let clean = text.replace(/[\t\n\f\r ]/g, '');
  if (options.alphabet === 'base64url') clean = clean.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex() {
  let text = '';
  for (const byte of this) text += byte.toString(16).padStart(2, '0');
  return text;
}

export async function bytes() {
  return new Uint8Array(await this.arrayBuffer());
}

export function promiseTry(fn, ...args) {
  return new this((resolve) => resolve(fn(...args)));
}

export function parseUrl(url, base) {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Methods every iterator has (on %IteratorPrototype%). The lazy ones are generators. */
export const iteratorHelpers = {
  *map(fn) {
    let i = 0;
    for (const value of this) yield fn(value, i++);
  },
  *filter(fn) {
    let i = 0;
    for (const value of this) if (fn(value, i++)) yield value;
  },
  *flatMap(fn) {
    let i = 0;
    for (const value of this) yield* fn(value, i++);
  },
  *take(limit) {
    if (!(limit > 0)) return;
    let i = 0;
    for (const value of this) {
      yield value;
      if (++i >= limit) return;
    }
  },
  *drop(limit) {
    let i = 0;
    for (const value of this) if (i++ >= limit) yield value;
  },
  toArray() {
    return [...this];
  },
  forEach(fn) {
    let i = 0;
    for (const value of this) fn(value, i++);
  },
  some(fn) {
    let i = 0;
    for (const value of this) if (fn(value, i++)) return true;
    return false;
  },
  every(fn) {
    let i = 0;
    for (const value of this) if (!fn(value, i++)) return false;
    return true;
  },
  find(fn) {
    let i = 0;
    for (const value of this) if (fn(value, i++)) return value;
    return undefined;
  },
  reduce(fn, ...initial) {
    let i = 0;
    let started = initial.length > 0;
    let total = initial[0];
    for (const value of this) {
      total = started ? fn(total, value, i) : value;
      started = true;
      i++;
    }
    if (!started) throw new TypeError('reduce of an empty iterator with no initial value');
    return total;
  },
  /** As pdf.js's legacy build defines it. */
  join(separator) {
    return [...this].join(separator);
  },
};

export const setMethods = {
  intersection(other) {
    const out = new Set();
    for (const value of this) if (other.has(value)) out.add(value);
    return out;
  },
  union(other) {
    const out = new Set(this);
    for (const value of other.keys()) out.add(value);
    return out;
  },
  difference(other) {
    const out = new Set();
    for (const value of this) if (!other.has(value)) out.add(value);
    return out;
  },
  symmetricDifference(other) {
    const out = new Set(this);
    for (const value of other.keys()) {
      if (this.has(value)) out.delete(value);
      else out.add(value);
    }
    return out;
  },
  isSubsetOf(other) {
    for (const value of this) if (!other.has(value)) return false;
    return true;
  },
  isSupersetOf(other) {
    for (const value of other.keys()) if (!this.has(value)) return false;
    return true;
  },
  isDisjointFrom(other) {
    for (const value of this) if (other.has(value)) return false;
    return true;
  },
};

/** Give `target` a method `name`, unless it has one. Not enumerable, as built-ins are. */
function define(target, name, value) {
  if (!target || typeof target[name] === 'function') return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

/** Install every one that is missing. Returns the names installed, for tests and for curiosity. */
export function install(scope = globalThis) {
  const before = new Set();
  const note = (target, name, value, label) => {
    if (target && typeof target[name] !== 'function') before.add(label);
    define(target, name, value);
  };
  note(scope.Math, 'sumPrecise', sumPrecise, 'Math.sumPrecise');
  for (const kind of ['Map', 'WeakMap']) {
    note(scope[kind]?.prototype, 'getOrInsert', getOrInsert, `${kind}.getOrInsert`);
    note(scope[kind]?.prototype, 'getOrInsertComputed', getOrInsertComputed, `${kind}.getOrInsertComputed`);
  }
  note(scope.Uint8Array?.prototype, 'toBase64', toBase64, 'Uint8Array.toBase64');
  note(scope.Uint8Array?.prototype, 'toHex', toHex, 'Uint8Array.toHex');
  note(scope.Uint8Array, 'fromBase64', fromBase64, 'Uint8Array.fromBase64');
  note(scope.Blob?.prototype, 'bytes', bytes, 'Blob.bytes');
  note(scope.Response?.prototype, 'bytes', bytes, 'Response.bytes');
  note(scope.Promise, 'try', promiseTry, 'Promise.try');
  note(scope.URL, 'parse', parseUrl, 'URL.parse');
  const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  for (const [name, fn] of Object.entries(iteratorHelpers)) note(iteratorPrototype, name, fn, `Iterator.${name}`);
  for (const [name, fn] of Object.entries(setMethods)) note(scope.Set?.prototype, name, fn, `Set.${name}`);
  return [...before];
}

install();
