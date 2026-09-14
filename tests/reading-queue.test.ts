import { describe, it, expect, vi } from 'vitest';

// The module under test also defines a storage item; stub WXT's storage so importing it is inert.
vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

const { withItemAdded, withItemMoved, withItemRemoved } = await import('@/shared/reading-queue');
type QueueItem = import('@/shared/reading-queue').QueueItem;

const q = (id: string, url: string, article = false): QueueItem => ({
  id,
  url,
  title: id,
  site: new URL(url).hostname,
  addedAt: 0,
  ...(article ? { article: { html: '<p>x</p>', text: 'x', lang: 'en', byline: null } } : {}),
});

describe('withItemAdded', () => {
  it('appends a new article', () => {
    const r = withItemAdded([q('a', 'https://x.test/1')], q('b', 'https://x.test/2'));
    expect(r.added).toBe(true);
    expect(r.queue.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not queue the same document twice, ignoring tracking parameters and fragments', () => {
    const r = withItemAdded([q('a', 'https://x.test/post?id=1')], q('b', 'https://x.test/post?id=1&utm_source=feed#top'));
    expect(r.added).toBe(false);
    expect(r.queue).toHaveLength(1);
  });

  it('upgrades a queued link with the article once it is added from the page', () => {
    const r = withItemAdded([q('a', 'https://x.test/1')], q('b', 'https://x.test/1', true));
    expect(r.added).toBe(false);
    expect(r.queue[0]!.id).toBe('a');
    expect(r.queue[0]!.article).toBeDefined();
  });

  it('refuses past the cap and says so', () => {
    const r = withItemAdded([q('a', 'https://x.test/1')], q('b', 'https://x.test/2'), 1);
    expect(r).toMatchObject({ added: false, full: true });
  });
});

describe('withItemMoved / withItemRemoved', () => {
  const list = [q('a', 'https://x.test/1'), q('b', 'https://x.test/2'), q('c', 'https://x.test/3')];

  it('moves an item up or down and clamps at the ends', () => {
    expect(withItemMoved(list, 'c', -1).map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(withItemMoved(list, 'a', -1).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(withItemMoved(list, 'a', 5).map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('removes by id', () => {
    expect(withItemRemoved(list, 'b').map((i) => i.id)).toEqual(['a', 'c']);
  });
});
