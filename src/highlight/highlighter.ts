/**
 * In-place sentence highlighting.
 *
 * Primary path: the CSS Custom Highlight API (`CSS.highlights`), which paints a `Range` with
 * zero DOM mutation — no reflow, no risk of breaking the page's layout. Requires Firefox 140+
 * or Chromium 105+.
 *
 * Fallback (older Firefox): wrap the range in a `<span>` and unwrap it on advance. This can
 * disturb layout in rare inline-splitting cases, so it is only used when `CSS.highlights` is
 * absent.
 */

import type { WordHighlightStyle } from '@/shared/settings';
import { backgroundUnder, parseColor, readableTextColor } from './contrast';

const HIGHLIGHT_NAME = 'aloud-sentence';
const WORD_HIGHLIGHT_NAME = 'aloud-word';
/**
 * The same highlights, for text the highlight would otherwise swallow.
 *
 * A `::highlight()` rule styles every range in that highlight, so "this sentence needs dark
 * letters" cannot be expressed by styling one range. It is expressed by putting the range in a
 * different highlight instead: same wash, letters forced dark or light. Which one a sentence
 * lands in is decided per sentence from the page's own colours (see contrast.ts).
 */
const DARK_TEXT_NAME = `${HIGHLIGHT_NAME}-dark`;
const LIGHT_TEXT_NAME = `${HIGHLIGHT_NAME}-light`;
const WORD_DARK_TEXT_NAME = `${WORD_HIGHLIGHT_NAME}-dark`;
const WORD_LIGHT_TEXT_NAME = `${WORD_HIGHLIGHT_NAME}-light`;
const DARK_INK = '#101014';
const LIGHT_INK = '#ffffff';
const STYLE_ID = 'aloud-highlight-style';
const SPAN_CLASS = 'aloud-hl-span';

export type ScrollMode = 'off' | 'keep-visible' | 'snap';

export interface HighlighterOptions {
  color: string;
  /**
   * `off` — never scroll. `keep-visible` — scroll only when the sentence leaves a margin
   * near the viewport edge. `snap` — pull the sentence to the vertical centre on every advance.
   */
  scrollMode: ScrollMode;
  /** How the word being spoken looks. `off` is handled by not showing words at all. */
  wordStyle?: WordHighlightStyle;
  /**
   * Give highlighted text a readable colour when the page's own colour would disappear into the
   * highlight. Off leaves the page's colours exactly as they are.
   */
  keepReadable?: boolean;
}

export class Highlighter {
  private readonly supportsCSSHighlight: boolean;
  private highlight: Highlight | null = null;
  private wordHighlight: Highlight | null = null;
  private currentSpan: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private lastScroll = 0;
  private readonly reduceMotion: boolean;

  constructor(private readonly doc: Document, private opts: HighlighterOptions) {
    this.supportsCSSHighlight =
      typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
    this.reduceMotion = doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
    this.injectStyle();
  }

  private injectStyle(): void {
    if (this.doc.getElementById(STYLE_ID)) {
      this.styleEl = this.doc.getElementById(STYLE_ID) as HTMLStyleElement;
      return;
    }
    const style = this.doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      ::highlight(${HIGHLIGHT_NAME}) {
        background-color: ${this.opts.color};
        color: inherit;
        border-radius: 2px;
      }
      ::highlight(${WORD_HIGHLIGHT_NAME}) {
        ${wordStyleCss(this.opts.color, this.opts.wordStyle ?? 'darker')}
      }
      ::highlight(${DARK_TEXT_NAME}) {
        background-color: ${this.opts.color};
        color: ${DARK_INK};
        border-radius: 2px;
      }
      ::highlight(${LIGHT_TEXT_NAME}) {
        background-color: ${this.opts.color};
        color: ${LIGHT_INK};
        border-radius: 2px;
      }
      ::highlight(${WORD_DARK_TEXT_NAME}) {
        ${wordStyleCss(this.opts.color, this.opts.wordStyle ?? 'darker')}
        color: ${DARK_INK};
      }
      ::highlight(${WORD_LIGHT_TEXT_NAME}) {
        ${wordStyleCss(this.opts.color, this.opts.wordStyle ?? 'darker')}
        color: ${LIGHT_INK};
      }
      .${SPAN_CLASS} {
        background-color: ${this.opts.color};
        border-radius: 2px;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
    `;
    (this.doc.head ?? this.doc.documentElement).appendChild(style);
    this.styleEl = style;
  }

  setOptions(opts: Partial<HighlighterOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
    this.injectStyle();
  }

  show(range: Range | null): void {
    if (!range) {
      this.clear();
      return;
    }
    if (this.supportsCSSHighlight) {
      this.paint(range, {
        plain: HIGHLIGHT_NAME,
        dark: DARK_TEXT_NAME,
        light: LIGHT_TEXT_NAME,
        held: (h) => (this.highlight = h),
      });
    } else {
      this.showWithSpan(range);
    }
    if (this.opts.scrollMode !== 'off') this.scrollIntoView(range);
  }

  /**
   * Fallback highlight: wrap the range in a `<span>`.
   *
   * `surroundContents` throws when the range partially selects a non-Text node (a sentence that
   * spans the end of an `<em>`, say). The tempting recovery — `extractContents()` then
   * `insertNode()` — must **not** be used: it moves nodes out of the document and back, which
   * silently invalidates every other `Range` the playlist is holding, so the rest of the
   * article's highlights land on the wrong text. Skipping the highlight for one sentence is far
   * cheaper than corrupting the index; the sentence is still spoken either way.
   */
  private showWithSpan(range: Range): void {
    this.unwrapSpan();
    try {
      const span = this.doc.createElement('span');
      span.className = SPAN_CLASS;
      range.surroundContents(span);
      this.currentSpan = span;
    } catch {
      this.currentSpan = null;
    }
  }

  private unwrapSpan(): void {
    const span = this.currentSpan;
    if (!span || !span.parentNode) {
      this.currentSpan = null;
      return;
    }
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    // Deliberately no `parent.normalize()`: merging the text nodes back together would shift the
    // offsets that the playlist's cached Ranges are built on, and drift the highlight from the
    // audio for the rest of the article. A few extra adjacent text nodes are harmless.
    this.currentSpan = null;
  }

  /**
   * Scroll the page to `range` because the *user* asked — the control bar's "take me back to
   * what is being read" button.
   *
   * Deliberately not `scrollIntoView`'s automatic path: it ignores the scroll-mode setting (the
   * request was explicit, so "don't scroll" does not apply to it) and ignores the rate limit
   * (which exists to stop automatic scrolling from fighting the reader, not to throttle a
   * button). Returns false when the range has no box to scroll to — a sentence in a collapsed
   * section, say — so the caller can say so instead of appearing to do nothing.
   */
  reveal(range: Range | null): boolean {
    if (!range) return false;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const el = range.startContainer.parentElement;
    if (!el) return false;
    this.lastScroll = Date.now();
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: this.reduceMotion ? 'auto' : 'smooth' });
    return true;
  }

  private scrollIntoView(range: Range): void {
    const snap = this.opts.scrollMode === 'snap';
    const now = Date.now();
    if (now - this.lastScroll < (snap ? 250 : 500)) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const view = this.doc.defaultView!;
    const margin = view.innerHeight * 0.15;
    const outOfView = rect.top < margin || rect.bottom > view.innerHeight - margin;
    if (snap || outOfView) {
      this.lastScroll = now;
      const el = range.startContainer.parentElement;
      el?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: this.reduceMotion ? 'auto' : 'smooth',
      });
    }
  }

  /** Whether this browser can mark a word inside the sentence (the CSS Custom Highlight API). */
  get canShowWords(): boolean {
    return this.supportsCSSHighlight;
  }

  /**
   * Mark the word being spoken, on top of the sentence highlight. Never scrolls: the sentence
   * already decides where the page is, and a scroll per word would never keep still.
   */
  showWord(range: Range | null): void {
    if (!this.supportsCSSHighlight) return;
    if (!range) {
      this.wordHighlight?.clear();
      return;
    }
    this.paint(range, {
      plain: WORD_HIGHLIGHT_NAME,
      dark: WORD_DARK_TEXT_NAME,
      light: WORD_LIGHT_TEXT_NAME,
      priority: 1,
      held: (h) => (this.wordHighlight = h),
    });
  }

  /**
   * Put `range` in whichever of the three highlights keeps it readable, and empty the other two
   * so the sentence is never painted twice.
   */
  private paint(
    range: Range,
    names: { plain: string; dark: string; light: string; priority?: number; held: (h: Highlight) => void },
  ): void {
    const ink = this.opts.keepReadable === false ? null : this.inkFor(range);
    const wanted = ink === DARK_INK ? names.dark : ink === LIGHT_INK ? names.light : names.plain;
    for (const name of [names.plain, names.dark, names.light]) {
      const existing = CSS.highlights.get(name);
      if (name === wanted) continue;
      existing?.clear();
    }
    let highlight = CSS.highlights.get(wanted);
    if (!highlight) {
      highlight = new Highlight();
      if (names.priority != null) highlight.priority = names.priority;
      CSS.highlights.set(wanted, highlight);
    }
    highlight.clear();
    highlight.add(range);
    names.held(highlight);
  }

  /**
   * The colour this range's letters need, or null to leave the page's own colour alone.
   *
   * Read from the page itself: the element's own colour, and the first ancestor that actually
   * paints a background (everything above it is transparent by default, and `html` falls back to
   * white — or to the canvas colour a dark page sets).
   */
  private inkFor(range: Range): string | null {
    const node = range.startContainer;
    const element = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as Element | null;
    const view = this.doc.defaultView;
    if (!element || !view) return null;
    const text = parseColor(view.getComputedStyle(element).color);
    const highlight = parseColor(this.opts.color);
    if (!text || !highlight) return null;
    return readableTextColor(text, backgroundUnder(element, view), highlight);
  }

  clear(): void {
    if (this.supportsCSSHighlight) {
      for (const name of [HIGHLIGHT_NAME, DARK_TEXT_NAME, LIGHT_TEXT_NAME, WORD_HIGHLIGHT_NAME, WORD_DARK_TEXT_NAME, WORD_LIGHT_TEXT_NAME]) {
        CSS.highlights.get(name)?.clear();
      }
    }
    this.unwrapSpan();
  }

  dispose(): void {
    this.clear();
    if (this.supportsCSSHighlight) {
      for (const name of [HIGHLIGHT_NAME, DARK_TEXT_NAME, LIGHT_TEXT_NAME, WORD_HIGHLIGHT_NAME, WORD_DARK_TEXT_NAME, WORD_LIGHT_TEXT_NAME]) {
        CSS.highlights.delete(name);
      }
    }
    this.highlight = null;
    this.wordHighlight = null;
    this.styleEl?.remove();
    this.styleEl = null;
  }
}

/**
 * The word mark as CSS. `darker` paints the word in a deeper shade of the sentence colour — easy to
 * follow without drawing anything across the text; `underline` leaves the colour alone and draws
 * a line in the same hue under the word.
 */
export function wordStyleCss(color: string, style: WordHighlightStyle): string {
  const tone = wordTone(color);
  if (style === 'underline') {
    return `color: inherit; text-decoration: underline 3px ${tone.line}; text-underline-offset: 2px;`;
  }
  return `background-color: ${tone.fill}; color: inherit;`;
}

/**
 * The word's colours from the sentence colour. The word is painted *over* the sentence highlight,
 * so its fill only adds a little (the two stack to about 0.6 at the default colour) — enough to
 * find the word, not so much that it hides the letters where text is drawn under the highlight,
 * as on a PDF page. A darker underline in the same hue does the rest.
 */
export function wordTone(color: string): { fill: string; line: string } {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/.exec(color);
  if (!m) return { fill: color, line: 'currentColor' };
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  const dark = (v: number) => Math.round(v * 0.55);
  return { fill: `rgba(${r}, ${g}, ${b}, ${Math.min(0.5, alpha * 0.7).toFixed(2)})`, line: `rgb(${dark(r)}, ${dark(g)}, ${dark(b)})` };
}
