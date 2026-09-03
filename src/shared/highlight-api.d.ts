/**
 * Minimal ambient types for the CSS Custom Highlight API (`CSS.highlights`, `Highlight`).
 * TypeScript's lib.dom does not yet include these in the version pinned here.
 * See https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API
 */

declare class Highlight {
  constructor(...ranges: AbstractRange[]);
  add(range: AbstractRange): void;
  delete(range: AbstractRange): boolean;
  clear(): void;
  has(range: AbstractRange): boolean;
  forEach(cb: (range: AbstractRange) => void): void;
  readonly size: number;
  priority: number;
  type: 'highlight' | 'spelling-error' | 'grammar-error';
}

interface HighlightRegistry extends Map<string, Highlight> {}

interface CSS {
  highlights: HighlightRegistry;
}
