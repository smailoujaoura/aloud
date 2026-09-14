import { describe, it, expect } from 'vitest';
import { endOfParagraph, endOfSection } from '@/content/sleep-timer';
import type { PlaylistItem } from '@/content/playlist';

/** A tiny article: heading, two paragraphs, heading, one paragraph. */
function item(playId: number, startsBlock: boolean, isHeading = false): PlaylistItem {
  return { playId, spokenText: `s${playId}`, range: null, blockRange: null, role: isHeading ? 'heading' : 'paragraph', startsBlock, isHeading };
}
const list = [
  item(0, true, true),  // # Intro
  item(1, true),        // para 1, sentence 1
  item(2, false),       //         sentence 2
  item(3, true),        // para 2
  item(4, false),
  item(5, true, true),  // # Next section
  item(6, true),
  item(7, false),
];

describe('sleep timer stop points', () => {
  it('stops at the last sentence of the current paragraph', () => {
    expect(endOfParagraph(list, 1)).toBe(2);
    expect(endOfParagraph(list, 2)).toBe(2);
    expect(endOfParagraph(list, 3)).toBe(4);
  });

  it('stops before the next heading for the end of a section', () => {
    expect(endOfSection(list, 1)).toBe(4);
    expect(endOfSection(list, 4)).toBe(4);
  });

  it('runs to the end of the article when nothing follows', () => {
    expect(endOfParagraph(list, 6)).toBe(7);
    expect(endOfSection(list, 6)).toBe(7);
  });
});
