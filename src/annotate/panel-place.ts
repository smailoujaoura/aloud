/**
 * Where the notes panel goes once the reader has moved it: the arithmetic, kept apart from the DOM
 * so it can be tested on its own (notes-panel.ts does the dragging).
 *
 * A moved panel is remembered as a spot: how far across the room it has to move it is, from 0 (the
 * left or top edge) to 1 (the right or bottom edge). The room is what the window leaves once the
 * panel and a margin are taken out, so any spot is fully inside the window, and a panel put in the
 * bottom-right corner stays in that corner when the window is resized.
 */

/** Where a moved panel sits: 0 is the left (top) of the room it can move in, 1 its right (bottom). */
export interface PanelSpot {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Kept this far inside the window's edges: the same as the side sheet it starts as. */
export const PANEL_MARGIN = 12;
/** Kept this far from the reading bar, as the side sheet is (it stops 92 px short of the bottom). */
export const BAR_GAP = 8;
/**
 * The tallest a moved panel is. As tall as the window it would be a side sheet that can only slide
 * sideways, and the reader who moved it wanted it somewhere of their choosing.
 */
export const MOVED_HEIGHT = 560;
/** Below this the list shows a note or two at most: better left under the bar than squashed. */
const MIN_HEIGHT = 160;
/**
 * At this width and below the panel stays the sheet it opens as. It is 360 px wide (and fills the
 * window from side to side below 384 px), so there is little room to move it; this is also the
 * reading bar's own phone width.
 */
export const NARROW_WIDTH = 560;

/** The panel's height once moved, in a window `view` tall. */
export function movedHeight(view: Size): number {
  return Math.max(0, Math.min(MOVED_HEIGHT, view.height - 2 * PANEL_MARGIN));
}

/** Where a panel of `size` at `spot` goes in the window `view`. */
export function placePanel(spot: PanelSpot, size: Size, view: Size): { left: number; top: number } {
  return {
    left: Math.round(PANEL_MARGIN + clamp01(spot.x) * Math.max(0, view.width - size.width - 2 * PANEL_MARGIN)),
    top: Math.round(PANEL_MARGIN + clamp01(spot.y) * Math.max(0, view.height - size.height - 2 * PANEL_MARGIN)),
  };
}

/** The spot a panel of `size` dragged to (`left`, `top`) is at: anywhere past an edge is that edge. */
export function spotOfPanel(left: number, top: number, size: Size, view: Size): PanelSpot {
  const width = view.width - size.width - 2 * PANEL_MARGIN;
  const height = view.height - size.height - 2 * PANEL_MARGIN;
  return {
    x: width > 0 ? clamp01((left - PANEL_MARGIN) / width) : 0,
    y: height > 0 ? clamp01((top - PANEL_MARGIN) / height) : 0,
  };
}

/** A stored spot, or null for anything that is not one (never set, put back, or damaged). */
export function validSpot(value: unknown): PanelSpot | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value as Partial<PanelSpot>;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x: clamp01(x), y: clamp01(y) } : null;
}

/**
 * The panel `panel`, moved off the reading bar `bar` when it is under it: the shortest move that
 * clears the bar and keeps the panel in the window — up, down, or to either side of it. When there
 * is no such move (a short window), it is made shorter, to fit the larger space above or below the
 * bar. Clear of the bar already, or with no bar, it stays exactly where it is.
 */
export function clearOfBar(panel: Box, bar: Box | null, view: Size): Box {
  if (!bar || !overlaps(panel, bar)) return panel;
  const lo = PANEL_MARGIN;
  const candidates: Box[] = [
    { ...panel, top: bar.top - BAR_GAP - panel.height },
    { ...panel, top: bar.top + bar.height + BAR_GAP },
    { ...panel, left: bar.left - BAR_GAP - panel.width },
    { ...panel, left: bar.left + bar.width + BAR_GAP },
  ].filter(
    (c) => c.left >= lo && c.top >= lo && c.left + c.width <= view.width - lo && c.top + c.height <= view.height - lo,
  );
  if (candidates.length) {
    const distance = (c: Box): number => Math.abs(c.left - panel.left) + Math.abs(c.top - panel.top);
    return candidates.reduce((best, c) => (distance(c) < distance(best) ? c : best));
  }
  const above = { top: lo, height: bar.top - BAR_GAP - lo };
  const below = { top: bar.top + bar.height + BAR_GAP, height: view.height - lo - (bar.top + bar.height + BAR_GAP) };
  const band = above.height >= below.height ? above : below;
  if (band.height < MIN_HEIGHT) return panel;
  return { ...panel, top: Math.round(band.top), height: Math.round(Math.min(panel.height, band.height)) };
}

/**
 * The box something covers in the window, found by asking `hit` whether it is at a point: what the
 * reading bar covers is drawn inside a closed shadow root, and its host element has no box of its
 * own (0 by 0, after the end of the page), so where it is can only be found this way.
 *
 * `region` is looked over on a grid `step` apart (each hit-test costs ~15 µs on a long page, so
 * the grid is coarse), and from what it finds the box is grown outwards 4 px at a time, past the
 * region if need be, for as long as its edges still find it. Null when nothing is hit.
 */
export function findBox(region: Box, step: { x: number; y: number }, view: Size, hit: (x: number, y: number) => boolean): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const right = Math.min(view.width, region.left + region.width);
  const bottom = Math.min(view.height, region.top + region.height);
  for (let y = Math.max(0, region.top) + step.y / 2; y < bottom; y += step.y) {
    for (let x = Math.max(0, region.left) + step.x / 2; x < right; x += step.x) {
      if (!hit(x, y)) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const GROW = 4;
  const along = (from: number, to: number, gap: number): number[] => {
    const at = [from, to];
    for (let v = from + gap; v < to; v += gap) at.push(v);
    return at;
  };
  const rowHit = (y: number): boolean => along(minX, maxX, step.x).some((x) => hit(x, y));
  const colHit = (x: number): boolean => along(minY, maxY, step.y).some((y) => hit(x, y));
  // Twice round: a box grown wider can then be found taller at its new corners, and the other way.
  for (let pass = 0; pass < 2; pass++) {
    while (minY - GROW >= 0 && rowHit(minY - GROW)) minY -= GROW;
    while (maxY + GROW < view.height && rowHit(maxY + GROW)) maxY += GROW;
    while (minX - GROW >= 0 && colHit(minX - GROW)) minX -= GROW;
    while (maxX + GROW < view.width && colHit(maxX + GROW)) maxX += GROW;
  }
  // The edge is somewhere in the last step not hit: count it as covered.
  const left = Math.max(0, minX - GROW);
  const top = Math.max(0, minY - GROW);
  return { left, top, width: Math.min(view.width, maxX + GROW) - left, height: Math.min(view.height, maxY + GROW) - top };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
