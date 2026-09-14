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

const HIGHLIGHT_NAME = 'aloud-sentence';
const WORD_HIGHLIGHT_NAME = 'aloud-word';
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
        background-color: ${wordTone(this.opts.color).fill};
        color: inherit;
        text-decoration: underline 3px ${wordTone(this.opts.color).line};
        text-underline-offset: 2px;
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
      if (!this.highlight) {
        this.highlight = new Highlight();
        CSS.highlights.set(HIGHLIGHT_NAME, this.highlight);
      }
      this.highlight.clear();
      this.highlight.add(range);
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
    if (!this.wordHighlight) {
      this.wordHighlight = new Highlight();
      this.wordHighlight.priority = 1;
      CSS.highlights.set(WORD_HIGHLIGHT_NAME, this.wordHighlight);
    }
    this.wordHighlight.clear();
    this.wordHighlight.add(range);
  }

  clear(): void {
    this.wordHighlight?.clear();
    if (this.highlight) this.highlight.clear();
    this.unwrapSpan();
  }

  dispose(): void {
    this.clear();
    if (this.supportsCSSHighlight) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
    }
    this.highlight = null;
    this.wordHighlight = null;
    this.styleEl?.remove();
    this.styleEl = null;
  }
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
