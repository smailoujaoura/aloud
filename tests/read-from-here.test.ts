// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { indexAtPosition } from '@/content/playlist-navigation';
import type { PlaylistItem } from '@/content/playlist';

/** Three paragraphs, one sentence each, as playlist items with real ranges. */
function page(): { playlist: PlaylistItem[]; texts: Text[]; gap: Element } {
  document.body.innerHTML = '<p>First sentence here.</p><div class="ad">Advertisement</div><p>Second sentence here.</p><p>Third sentence here.</p>';
  const paras = [...document.querySelectorAll('p')];
  const texts = paras.map((p) => p.firstChild as Text);
  const playlist = texts.map((t, playId) => {
    const range = document.createRange();
    range.selectNodeContents(t);
    return { playId, range } as unknown as PlaylistItem;
  });
  return { playlist, texts, gap: document.querySelector('.ad')! };
}

describe('Read from here, once the right-click spot is known (#4)', () => {
  it('starts at the sentence that holds the spot, not the first on screen', () => {
    const { playlist, texts } = page();
    expect(indexAtPosition(playlist, texts[2]!, 5)).toBe(2);
    expect(indexAtPosition(playlist, texts[1]!, 0)).toBe(1);
  });

  it('a spot between sentences starts at the next one', () => {
    const { playlist, gap } = page();
    expect(indexAtPosition(playlist, gap.firstChild!, 3)).toBe(1);
  });

  it('a spot no longer in the page gives nothing, so the reader falls back', () => {
    const { playlist } = page();
    const gone = document.createTextNode('detached');
    expect(indexAtPosition(playlist, gone, 0)).toBeNull();
  });
});
