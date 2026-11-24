/**
 * Where the reading bar goes when it is dragged: the arithmetic, apart from the DOM so it can be
 * tested on its own (control-bar.ts does the pointer handling).
 *
 * The bar is not placed freely. It sits at the bottom of the window or at the top (settings:
 * barDock), and a drag only chooses between the two: while the pointer holds it, it follows the
 * pointer up and down, and let go it goes to the edge it is nearer.
 */
import type { BarDock } from '@/shared/settings';

/** How far a press must move before it is a drag rather than a click (as touch-button.ts). */
export const DRAG_PX = 8;
/** Kept this far inside the window while it is held. */
const EDGE_GAP = 4;

/**
 * How far the bar may follow the pointer from where it was pressed: `dy`, held so that the bar
 * (`top` to `bottom` when pressed) stays inside a window `viewHeight` tall. A flick past the edge
 * left it hanging off the window, half out of reach, until the release put it back.
 */
export function dragOffset(dy: number, top: number, bottom: number, viewHeight: number): number {
  if (!Number.isFinite(dy)) return 0;
  const up = -(top - EDGE_GAP);
  const down = viewHeight - EDGE_GAP - bottom;
  // A window shorter than the bar: it does not move rather than jump about.
  if (down < up) return 0;
  return Math.min(down, Math.max(up, dy));
}

/**
 * The edge a bar let go of at `top` to `bottom` goes to: the nearer one, by its middle. Past the
 * middle of the window is the other edge; short of it, the bar goes back where it was.
 */
export function edgeAfterDrag(top: number, bottom: number, viewHeight: number): BarDock {
  return (top + bottom) / 2 < viewHeight / 2 ? 'top' : 'bottom';
}

/**
 * Whether a press on the bar can pick it up: on its own surface (the gaps, the dividers, the
 * counter's text), not on a button, the progress bar, the speed list or another control, which
 * keep their presses.
 */
export const NOT_A_HANDLE = 'button, select, input, textarea, a, label, [role="slider"], .progress';
