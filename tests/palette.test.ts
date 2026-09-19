import { vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { describe, expect, it } from 'vitest';
import { colorFor, inkFor, markCss, markName, parseHex } from '@/annotate/palette';
import { DEFAULT_NOTE_COLORS } from '@/shared/settings';

describe('note palette', () => {
  it('darkens a fill into an underline ink', () => {
    expect(inkFor('#ffd83a')).toBe('#998223');
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(parseHex('gold')).toBeNull();
  });

  it('falls back to the first colour for an id no longer in the palette', () => {
    expect(colorFor(DEFAULT_NOTE_COLORS, 'gone').id).toBe('yellow');
    expect(colorFor([], undefined).id).toBe('yellow');
  });

  it('names and styles a highlight and an underline per colour', () => {
    expect(markName('blue', 'underline')).toBe('aloud-note-blue-underline');
    const css = markCss([{ id: 'blue', label: 'Blue', fill: '#8cc8ff' }]);
    expect(css).toContain('::highlight(aloud-note-blue-highlight) { background-color: #8cc8ff99');
    expect(css).toContain('::highlight(aloud-note-blue-underline) { text-decoration: underline 3px #547899');
  });
});
