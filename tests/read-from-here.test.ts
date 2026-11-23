// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { indexAtPosition, indexNearElement } from '@/content/playlist-navigation';
import type { PlaylistItem } from '@/content/playlist';
import { buildTextIndex, type TextIndex } from '@/extract/text-index';

/** Three paragraphs, one sentence each, as playlist items placed in the page's text. */
function page(): { playlist: PlaylistItem[]; index: TextIndex; texts: Text[]; gap: Element } {
  document.body.innerHTML = '<p>First sentence here.</p><div class="ad">Advertisement</div><p>Second sentence here.</p><p>Third sentence here.</p>';
  const paras = [...document.querySelectorAll('p')];
  const texts = paras.map((p) => p.firstChild as Text);
  const index = buildTextIndex(document.body);
  const playlist = texts.map((t, playId) => {
    const start = index.fullText.indexOf(t.data);
    return { playId, span: { start, end: start + t.data.length }, blockSpan: null } as unknown as PlaylistItem;
  });
  return { playlist, index, texts, gap: document.querySelector('.ad')! };
}

describe('Read from here, once the right-click spot is known (#4)', () => {
  it('starts at the sentence that holds the spot, not the first on screen', () => {
    const { playlist, index, texts } = page();
    expect(indexAtPosition(playlist, index, texts[2]!, 5)).toBe(2);
    expect(indexAtPosition(playlist, index, texts[1]!, 0)).toBe(1);
  });

  it('a spot between sentences starts at the next one', () => {
    const { playlist, index, gap } = page();
    expect(indexAtPosition(playlist, index, gap.firstChild!, 3)).toBe(1);
  });

  it('a spot no longer in the page gives nothing, so the reader falls back', () => {
    const { playlist, index } = page();
    const gone = document.createTextNode('detached');
    expect(indexAtPosition(playlist, index, gone, 0)).toBeNull();
  });

  it('an element right-clicked starts at the first sentence at or after it', () => {
    const { playlist, index, gap } = page();
    expect(indexNearElement(playlist, index, gap)).toBe(1);
    expect(indexNearElement(playlist, index, document.querySelectorAll('p')[2]!)).toBe(2);
  });
});
