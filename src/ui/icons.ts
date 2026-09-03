/**
 * Icon geometry for the control bar, as SVG path data on a 16×16 grid.
 *
 * Inline paths rather than an icon font or sprite sheet: the bar is injected into pages we do
 * not control, so it must not depend on a network fetch, a font load, or anything the host
 * page's CSS could reach. `svgIcon()` in shared/dom.ts turns these into elements.
 */
export const ICON_PATHS = {
  play: ['M4 2.5v11l9-5.5z'],
  pause: ['M4 2.5h3v11H4z', 'M9 2.5h3v11H9z'],
  prev: ['M5 2.5v11H3.5v-11z', 'M13 2.5v11l-7-5.5z'],
  next: ['M11 2.5v11h1.5v-11z', 'M3 2.5v11l7-5.5z'],
  gear: [
    'M8 5a3 3 0 100 6 3 3 0 000-6zm6 3a6 6 0 01-.1 1l1.7 1.3-1.6 2.8-2-.8a6 6 0 01-1.7 1l-.3 2.1H6.3L6 15.6a6 6 0 01-1.7-1l-2 .8L.7 12.6 2.4 11a6 6 0 010-2L.7 7.7l1.6-2.8 2 .8A6 6 0 016 2.7L6.3.6h3.4l.3 2.1a6 6 0 011.7 1l2-.8 1.6 2.8L13.9 7q.1.5.1 1z',
  ],
  close: ['M4 3l4 4 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z'],
  /** Crosshair — "click a sentence to jump there". */
  target: [
    'M8 0a1 1 0 011 1v1.06A6 6 0 0113.94 7H15a1 1 0 010 2h-1.06A6 6 0 019 13.94V15a1 1 0 01-2 0v-1.06A6 6 0 012.06 9H1a1 1 0 010-2h1.06A6 6 0 017 2.06V1a1 1 0 011-1zm0 4a4 4 0 100 8 4 4 0 000-8z',
    'M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  ],
} as const;
