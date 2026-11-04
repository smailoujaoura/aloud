/**
 * Room at the end of the page for the reading bar.
 *
 * The bar floats over the bottom of the window. Scrolled to the end of an article, the last lines
 * sat under it with nowhere further to go. This puts an empty, invisible block as tall as the bar
 * covers at the end of what scrolls the article (the page, or the panel a site scrolls it in), so
 * they can be scrolled up above the bar. It shows whatever is behind it: the page's own background.
 *
 * A block rather than padding: many sites set `html, body { height: 100% }`, which puts padding at
 * the bottom of the window, not after the content. It is removed with the bar.
 */
import { scrollerOf } from '@/highlight/smooth-scroll';

const ROOM_ATTR = 'data-aloud-room';

export class BottomRoom {
  private block: HTMLElement | null = null;
  private content: Element | null = null;
  private height = 0;

  constructor(private readonly doc: Document) {}

  /** The article being read: the room goes at the end of what scrolls it. */
  setContent(content: Element | null): void {
    this.content = content;
    this.place();
  }

  /** How much room the bar needs: what it covers of the window. */
  setHeight(px: number): void {
    const height = Math.max(0, Math.ceil(px));
    if (height === this.height && this.block?.isConnected) return;
    this.height = height;
    this.place();
  }

  remove(): void {
    this.block?.remove();
    this.block = null;
  }

  private place(): void {
    const into = (this.content?.isConnected ? (scrollerOf(this.content) as HTMLElement | null) : null) ?? this.doc.body;
    if (!into || this.height <= 0) {
      this.remove();
      return;
    }
    if (!this.block) {
      this.block = this.doc.createElement('div');
      this.block.setAttribute(ROOM_ATTR, '');
      this.block.setAttribute('aria-hidden', 'true');
    }
    // Nothing of the page's styles reaches it, and it takes no part in a flex or grid layout
    // beyond its own height.
    this.block.style.cssText =
      `all: initial; display: block; width: 1px; height: ${this.height}px; margin: 0; padding: 0; ` +
      'flex: none; clear: both; visibility: hidden; pointer-events: none;';
    // Last, after anything the page has added since.
    if (into.lastElementChild !== this.block) into.append(this.block);
  }
}
