/**
 * Following the reading without lurching.
 *
 * `scrollIntoView({ behavior: 'smooth' })` gives the browser's own animation: short, fixed, the
 * same for a line as for a screen, and every jump re-centred the sentence — a page that lurched
 * by half a screen every few sentences, which people described as dizzying. This moves by
 * distance instead: a short move is quick, a long one takes longer but never more than a moment,
 * and it eases in and out. A move asked for while another is under way carries on from where the
 * page is, easing out only, so it never stops dead and starts again.
 *
 * The reader's own hand always wins: a wheel, a touch, a key or a press on the scrollbar stops the
 * animation where it is. With reduced motion asked for, it jumps.
 */

interface Animation {
  scroller: Element | null; // null: the window
  from: number;
  to: number;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** How long a move of `distance` pixels takes: 320 ms for a line, up to 760 ms for a screen and more. */
export function scrollDuration(distance: number): number {
  return Math.round(Math.min(760, 320 + Math.abs(distance) * 0.5));
}

export class SmoothScroller {
  private animation: Animation | null = null;
  private frame = 0;
  private readonly stop = (): void => this.cancel();

  constructor(
    private readonly view: Window,
    private readonly reduceMotion: boolean,
  ) {
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
      view.addEventListener(type, this.stop, { passive: true, capture: true });
    }
  }

  /** Is an animation of ours moving the page right now? */
  get moving(): boolean {
    return this.animation !== null;
  }

  /** Move `scroller` (null: the window) so its scroll position changes by `delta` pixels. */
  by(scroller: Element | null, delta: number): void {
    if (Math.abs(delta) < 1) return;
    const current = this.position(scroller);
    const max = this.maxScroll(scroller);
    const to = Math.max(0, Math.min(max, (this.animation?.scroller === scroller ? this.animation.to : current) + delta));
    if (this.reduceMotion) {
      this.cancel();
      this.set(scroller, to);
      return;
    }
    const continuing = this.animation !== null && this.animation.scroller === scroller;
    this.animation = {
      scroller,
      from: current,
      to,
      start: performance.now(),
      duration: scrollDuration(to - current),
      ease: continuing ? easeOut : easeInOut,
    };
    if (!this.frame) this.frame = this.view.requestAnimationFrame((t) => this.step(t));
  }

  cancel(): void {
    this.animation = null;
    if (this.frame) this.view.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  dispose(): void {
    this.cancel();
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
      this.view.removeEventListener(type, this.stop, { capture: true });
    }
  }

  private step(now: number): void {
    this.frame = 0;
    const a = this.animation;
    if (!a) return;
    const t = Math.min(1, Math.max(0, (now - a.start) / a.duration));
    this.set(a.scroller, a.from + (a.to - a.from) * a.ease(t));
    if (t < 1) this.frame = this.view.requestAnimationFrame((next) => this.step(next));
    else this.animation = null;
  }

  private position(scroller: Element | null): number {
    return scroller ? scroller.scrollTop : this.view.scrollY;
  }

  private maxScroll(scroller: Element | null): number {
    if (scroller) return scroller.scrollHeight - scroller.clientHeight;
    const doc = this.view.document.scrollingElement ?? this.view.document.documentElement;
    return doc.scrollHeight - this.view.innerHeight;
  }

  private set(scroller: Element | null, top: number): void {
    if (scroller) scroller.scrollTop = top;
    else this.view.scrollTo(this.view.scrollX, top);
  }
}

/** The element that scrolls `el` vertically, or null when it is the window. */
export function scrollerOf(el: Element): Element | null {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  for (let at = el.parentElement; at && at !== doc.body && at !== doc.documentElement; at = at.parentElement) {
    if (at.scrollHeight <= at.clientHeight + 1) continue;
    const overflow = view?.getComputedStyle(at).overflowY ?? '';
    if (/(auto|scroll|overlay)/.test(overflow)) return at;
  }
  return null;
}
