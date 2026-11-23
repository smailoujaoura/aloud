// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Highlighter } from '@/highlight/highlighter';
import { buildTextIndex } from '@/extract/text-index';
import { buildArticlePlaylist, itemRange } from '@/content/playlist';

/**
 * Where the browser has no CSS Custom Highlight API (Safari before 17.2), the sentence is marked by
 * wrapping it in a span, which cuts its text node in two or three. Sentences are found by their
 * offsets in the text nodes the page had when it was read, so the node must be whole again once
 * the mark moves on, or every later sentence of the paragraph loses its highlight.
 */
describe('the span highlight leaves the page’s text nodes as it found them', () => {
  function read(html: string) {
    document.body.innerHTML = html;
    const index = buildTextIndex(document.querySelector('article')!);
    const items = buildArticlePlaylist({ index, lang: 'en', maxChars: 240, normalize: (t) => t, referenceText: index.fullText, title: '' }).filter((i) => i.span);
    const highlighter = new Highlighter(document, { color: 'rgba(255, 214, 10, 0.45)', scrollMode: 'off' });
    return { index, items, highlighter };
  }

  it('each sentence of one paragraph is marked in turn, by one Range', () => {
    const { index, items, highlighter } = read('<article><p>One sentence here. Another sentence here. A third one.</p></article>');
    expect(highlighter.canShowWords).toBe(false); // the span path is the one under test
    const p = document.querySelector('p')!;
    const text = p.firstChild as Text;
    const one = document.createRange();
    const marked: string[] = [];
    for (const item of items) {
      highlighter.settle(); // as the reader does before it looks a sentence up
      const range = itemRange(index, item, one);
      expect(range).not.toBeNull();
      highlighter.show(range);
      marked.push(p.querySelector('span')?.textContent ?? '');
    }
    expect(marked).toEqual(['One sentence here.', 'Another sentence here.', 'A third one.']);
    highlighter.clear();
    expect(p.childNodes.length).toBe(1);
    expect(p.firstChild).toBe(text);
    expect(text.data).toBe('One sentence here. Another sentence here. A third one.');
  });

  it('a sentence across an inline element is put back too', () => {
    const { index, items, highlighter } = read('<article><p>One <b>bold</b> sentence here. Another <i>one</i> follows it.</p></article>');
    const p = document.querySelector('p')!;
    const before = [...p.childNodes];
    const data = before.map((n) => n.textContent);
    const one = document.createRange();
    for (const item of items) {
      highlighter.settle();
      highlighter.show(itemRange(index, item, one));
    }
    highlighter.clear();
    expect([...p.childNodes]).toEqual(before);
    expect([...p.childNodes].map((n) => n.textContent)).toEqual(data);
    // And every sentence can still be found.
    expect(items.map((item) => itemRange(index, item)?.toString())).toEqual(['One bold sentence here.', 'Another one follows it.']);
  });
});
