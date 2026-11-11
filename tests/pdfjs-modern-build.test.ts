import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Aloud ships pdf.js's modern build with its own polyfills (public/pdfjs-support/polyfills.mjs)
 * instead of the legacy build, whose core-js the Chrome Web Store rejected. These prove the two
 * read the same, on an engine without any of the built-ins the polyfills supply.
 */

interface PolyfillModule {
  sumPrecise(items: Iterable<number>): number;
  toBase64(this: Uint8Array, options?: { alphabet?: string; omitPadding?: boolean }): string;
  fromBase64(text: string, options?: { alphabet?: string }): Uint8Array;
  toHex(this: Uint8Array): string;
  getOrInsertComputed(this: Map<string, number>, key: string, compute: (key: string) => number): number;
  promiseTry(this: PromiseConstructor, fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown>;
  parseUrl(url: string, base?: string): URL | null;
  iteratorHelpers: Record<string, (this: Iterator<unknown>, ...args: never[]) => unknown>;
  setMethods: Record<string, (this: Set<unknown>, other: Set<unknown>) => unknown>;
}
// By URL: the file is plain JavaScript as shipped, with no types for TypeScript to find.
const polyfills = (await import(/* @vite-ignore */ new URL('../public/pdfjs-support/polyfills.mjs', import.meta.url).href)) as PolyfillModule;

describe('the built-ins pdf.js needs', () => {
  const { sumPrecise } = polyfills;

  it('Math.sumPrecise is exact, rounded once', () => {
    expect(sumPrecise([1e20, 0.1, -1e20])).toBe(0.1);
    expect(sumPrecise([0.1, 0.2, 0.3])).toBe(0.6); // a plain sum gives 0.6000000000000001
    expect(sumPrecise(Array(10).fill(0.1))).toBe(1);
    expect(sumPrecise([3, 4, 5])).toBe(12);
    expect(Object.is(sumPrecise([]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, -0]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, 0]), 0)).toBe(true);
    expect(sumPrecise([1, Infinity])).toBe(Infinity);
    expect(sumPrecise([Infinity, -Infinity])).toBeNaN();
    expect(() => sumPrecise(['1' as unknown as number])).toThrow(TypeError);
    // Against a sum done with exact rationals.
    const values = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 10 ** ((i % 7) - 3));
    const exact = values.reduce((acc, v) => acc + BigInt(Math.round(v * 2 ** 60)), 0n);
    expect(Math.abs(sumPrecise(values) - Number(exact) / 2 ** 60)).toBeLessThan(1e-12);
  });

  it('base64 and hex, as the built-ins give them', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(polyfills.toBase64.call(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(polyfills.toBase64.call(bytes, { alphabet: 'base64url', omitPadding: true })).toBe(Buffer.from(bytes).toString('base64url'));
    expect([...polyfills.fromBase64(Buffer.from(bytes).toString('base64'))]).toEqual([...bytes]);
    expect([...polyfills.fromBase64(' AAEC +vv8 /f7/ ')]).toEqual([...bytes]);
    expect([...polyfills.fromBase64(Buffer.from(bytes).toString('base64url'), { alphabet: 'base64url' })]).toEqual([...bytes]);
    expect(polyfills.toHex.call(bytes)).toBe('000102fafbfcfdfeff');
    const big = new Uint8Array(100_000).map((_, i) => i * 7);
    expect(polyfills.toBase64.call(big)).toBe(Buffer.from(big).toString('base64'));
  });

  it('getOrInsertComputed computes once', () => {
    const map = new Map<string, number>();
    let calls = 0;
    const make = (k: string) => (calls++, k.length);
    expect(polyfills.getOrInsertComputed.call(map, 'abc', make)).toBe(3);
    expect(polyfills.getOrInsertComputed.call(map, 'abc', make)).toBe(3);
    expect(calls).toBe(1);
  });

  it('Promise.try turns a throw into a rejection; URL.parse a bad address into null', async () => {
    await expect(polyfills.promiseTry.call(Promise, () => 4)).resolves.toBe(4);
    await expect(
      polyfills.promiseTry.call(Promise, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(polyfills.parseUrl('not a url')).toBeNull();
    expect(polyfills.parseUrl('/a', 'https://example.org/b')?.href).toBe('https://example.org/a');
  });

  it('iterator helpers and Set methods give what the built-ins give', () => {
    const h = polyfills.iteratorHelpers;
    const it = () => new Map([['a', 1], ['b', 2], ['c', 3]]).values();
    const call = (name: string, ...args: unknown[]) => (h[name] as (...a: unknown[]) => unknown).call(it(), ...args);
    expect([...(call('map', (v: number) => v * 2) as Iterable<number>)]).toEqual([2, 4, 6]);
    expect([...(call('filter', (v: number) => v > 1) as Iterable<number>)]).toEqual([2, 3]);
    expect([...(call('take', 2) as Iterable<number>)]).toEqual([1, 2]);
    expect([...(call('drop', 2) as Iterable<number>)]).toEqual([3]);
    expect([...(call('flatMap', (v: number) => [v, v]) as Iterable<number>)]).toEqual([1, 1, 2, 2, 3, 3]);
    expect(call('some', (v: number) => v === 2)).toBe(true);
    expect(call('every', (v: number) => v > 0)).toBe(true);
    expect(call('find', (v: number) => v > 1)).toBe(2);
    expect(call('reduce', (a: number, v: number) => a + v)).toBe(6);
    expect(call('toArray')).toEqual([1, 2, 3]);
    expect(call('join', '')).toBe('123');
    const s = polyfills.setMethods;
    const a = new Set([1, 2, 3]);
    const b = new Set([2, 3, 4]);
    expect([...(s.intersection!.call(a, b) as Set<number>)]).toEqual([2, 3]);
    expect([...(s.union!.call(a, b) as Set<number>)]).toEqual([1, 2, 3, 4]);
    expect([...(s.difference!.call(a, b) as Set<number>)]).toEqual([1]);
    expect([...(s.symmetricDifference!.call(a, b) as Set<number>)]).toEqual([1, 4]);
    expect(s.isSubsetOf!.call(new Set([2]), a)).toBe(true);
    expect(s.isSupersetOf!.call(a, new Set([1, 3]))).toBe(true);
    expect(s.isDisjointFrom!.call(a, new Set([9]))).toBe(true);
  });
});

describe('pdf.js’s modern build, on an engine without those built-ins', () => {
  it('reads every test PDF exactly as the legacy build does', async () => {
    const files = readdirSync('tests/fixtures/pdf')
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => `tests/fixtures/pdf/${f}`);
    const run = JSON.parse(execFileSync(process.execPath, ['tests/helpers/pdf-text-old-engine.mjs', ...files], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as {
      out: Record<string, string>;
      missing: string[];
    };
    expect(run.missing).toEqual([]);
    for (const file of files) {
      const task = getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
      const doc = await task.promise;
      const pages: string[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join('|'));
      }
      await task.destroy();
      expect(run.out[file], file).toBe(pages.join('\n'));
      expect(run.out[file]?.length, file).toBeGreaterThan(20);
    }
  }, 120_000);
});
