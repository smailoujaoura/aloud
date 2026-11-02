import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));
const { documentKey, formerDocumentKey } = await import('@/shared/position-match');
const { notesForPage } = await import('@/shared/notes');

describe('which document an address is, on sites that route by the #', () => {
  it('two articles of a hash-routed app are two documents', () => {
    const one = documentKey('https://example.test/#/article/one');
    const two = documentKey('https://example.test/#/article/two');
    expect(one).toBe('https://example.test/#/article/one');
    expect(two).not.toBe(one);
    expect(documentKey('https://example.test/#!/post/7')).toBe('https://example.test/#!/post/7');
    expect(documentKey('https://example.test/#!post-7')).toBe('https://example.test/#!post-7');
  });

  it('a place on the page is still the same page', () => {
    const page = documentKey('https://example.test/story');
    expect(documentKey('https://example.test/story#section-2')).toBe(page);
    expect(documentKey('https://example.test/story#:~:text=keeper')).toBe(page);
    expect(documentKey('https://example.test/story?utm_source=x#top')).toBe(page);
    // The app's start page: `#/` alone.
    expect(documentKey('https://example.test/#/')).toBe(documentKey('https://example.test/'));
  });

  it('a route followed by a text link keeps the route only', () => {
    expect(documentKey('https://example.test/#/article/one:~:text=keeper')).toBe('https://example.test/#/article/one');
  });

  it('the key before routes were kept drops every fragment', () => {
    expect(formerDocumentKey('https://example.test/#/article/one')).toBe('https://example.test/');
  });

  it('notes made on a routed page under the old key show on that page, and only there', () => {
    const note = (key: string, url: string) =>
      ({ id: url, text: 'x', source: { key, title: 't', site: 'example.test', reopen: { kind: 'web', url } } }) as unknown as Parameters<typeof notesForPage>[0][number];
    const old1 = note('https://example.test/', 'https://example.test/#/article/one');
    const old2 = note('https://example.test/', 'https://example.test/#/article/two');
    const fresh = note('https://example.test/#/article/one', 'https://example.test/#/article/one');
    const here = notesForPage([old1, old2, fresh], documentKey('https://example.test/#/article/one'));
    expect(here.map((n) => n.id)).toEqual([old1.id, fresh.id]);
  });
});
