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
  /** Arrow into a baseline — "scroll back to the sentence being read". */
  /**
   * Scroll back to the sentence being read: lines of text with a marker against the middle one.
   *
   * It used to be a downward arrow over a baseline, which is the universal "download" glyph —
   * people read the button as "save this page", which is not what it does.
   */
  snap: [
    'M2.2 2.4h11.6v1.5H2.2z',
    'M6 7.25h7.8v1.5H6z',
    'M2.2 12.1h11.6v1.5H2.2z',
    'M1.4 6.1l3.2 1.9-3.2 1.9z',
  ],
  /** Sun / moon / monitor — the theme picker on the settings and walkthrough pages. */
  sun: [
    'M8 4.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zm0 1.6a1.9 1.9 0 110 3.8 1.9 1.9 0 010-3.8z',
    'M7.2 0h1.6v2.4H7.2zm0 13.6h1.6V16H7.2zM0 7.2h2.4v1.6H0zm13.6 0H16v1.6h-2.4zM2.2 3.3l1.1-1.1 1.7 1.7-1.1 1.1zm9.8 9.8l1.1-1.1 1.7 1.7-1.1 1.1zm1.7-9.8l-1.1-1.1-1.7 1.7 1.1 1.1zM3.3 13.1l-1.1-1.1 1.7-1.7 1.1 1.1z',
  ],
  /** A turning-back arrow — "back a little". */
  replay: ['M8 2.2a5.8 5.8 0 11-5.6 7.3l1.6-.4A4.1 4.1 0 108 3.9a4 4 0 00-2.9 1.2l1.7 1.7H2.2V2.2l1.7 1.7A5.8 5.8 0 018 2.2z'],
  /** A bookmark ribbon with a plus — "save to notes". */
  bookmark: ['M4 1.5h8a1 1 0 011 1v12.3l-5-3.2-5 3.2V2.5a1 1 0 011-1zm.7 1.7v8.9L8 10l3.3 2.1V3.2z', 'M7.2 4.4h1.6v1.8h1.8v1.6H8.8v1.8H7.2V7.8H5.4V6.2h1.8z'],
  /** Arrow into a tray — save the document as an audio file. */
  download: ['M7 1.5h2v6l2.2-2.2 1.4 1.4L8 11.4 3.4 6.7l1.4-1.4L7 7.5z', 'M3 13h10v1.8H3z'],
  moon: ['M6.6 1.4a6.6 6.6 0 108 8 5.2 5.2 0 01-8-8z'],
  monitor: ['M1.5 2h13a1 1 0 011 1v7.5a1 1 0 01-1 1H9v1.7h2.5V15h-7v-1.8H7v-1.7H1.5a1 1 0 01-1-1V3a1 1 0 011-1zm.6 1.6v6.3h11.8V3.6z'],
  /** Question mark in a circle — "show me how this works". */
  help: [
    'M8 0a8 8 0 100 16A8 8 0 008 0zm0 1.7a6.3 6.3 0 110 12.6 6.3 6.3 0 010-12.6z',
    'M7.2 11.2h1.7v1.7H7.2zm.9-8c-1.6 0-2.7 1-2.8 2.5h1.6c.05-.7.5-1.1 1.2-1.1.6 0 1.1.4 1.1 1 0 .5-.2.8-.9 1.3-.7.5-1 1-1 1.9v.4h1.6v-.3c0-.5.2-.8.9-1.3.8-.6 1.1-1.1 1.1-2 0-1.4-1.1-2.4-2.8-2.4z',
  ],
  check: ['M13.5 3.5l1.2 1.2-8 8-4-4 1.2-1.2 2.8 2.8z'],
  /** Crosshair — "click a sentence to jump there". */
  target: [
    'M8 0a1 1 0 011 1v1.06A6 6 0 0113.94 7H15a1 1 0 010 2h-1.06A6 6 0 019 13.94V15a1 1 0 01-2 0v-1.06A6 6 0 012.06 9H1a1 1 0 010-2h1.06A6 6 0 017 2.06V1a1 1 0 011-1zm0 4a4 4 0 100 8 4 4 0 000-8z',
    'M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  ],
} as const;
