/**
 * Colours and styles for marks on web pages.
 *
 * The palette is the reader's own (settings: annotate.colors): each colour has a stable id that
 * notes store, and a label and fill that can be changed at any time — a note keeps its colour id,
 * so recolouring "Blue" recolours every blue note at once. A mark is either a highlight (the fill,
 * translucent, behind the text) or an underline (a darker tone of the same colour, under it).
 */
import { DEFAULT_NOTE_COLORS, type NoteColor, type NoteStyle } from '@/shared/settings';

export const NOTE_STYLES: readonly NoteStyle[] = ['highlight', 'underline'];

/** The palette entry for `id`, falling back to the first colour for ids no longer in it. */
export function colorFor(palette: readonly NoteColor[], id: string | undefined): NoteColor {
  const list = palette.length ? palette : DEFAULT_NOTE_COLORS;
  return list.find((c) => c.id === id) ?? list[0]!;
}

/** `#rrggbb` → a darker tone of it, readable as an underline on a light page. */
export function inkFor(fill: string): string {
  const rgb = parseHex(fill);
  if (!rgb) return fill;
  const dark = rgb.map((v) => Math.round(v * 0.6));
  return `#${dark.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** A CSS highlight name per colour and style: `aloud-note-blue-underline`. */
export function markName(colorId: string, style: NoteStyle): string {
  return `aloud-note-${colorId.replace(/[^a-z0-9_-]/gi, '')}-${style}`;
}

/** The `::highlight()` rules for every colour in both styles. */
export function markCss(palette: readonly NoteColor[]): string {
  return palette
    .flatMap((c) => [
      `::highlight(${markName(c.id, 'highlight')}) { background-color: ${c.fill}99; color: inherit; }`,
      `::highlight(${markName(c.id, 'underline')}) { text-decoration: underline 3px ${inkFor(c.fill)}; text-underline-offset: 3px; color: inherit; }`,
    ])
    .join('\n');
}

/** Accepts `#rgb` and `#rrggbb`; null for anything else. */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
