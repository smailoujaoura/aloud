import { describe, expect, it } from 'vitest';
import { toItem } from '@/pdf/load-pdf';

/**
 * pdf.js's viewport at scale 1 for a 612 × 792 page with /Rotate `rotation`: the same transform
 * PageViewport builds (pdf.js display/display_utils.js), as a point mapping (y down).
 */
function viewport(rotation: 0 | 90 | 180 | 270) {
  const [w, h] = [612, 792];
  const [cx, cy] = [w / 2, h / 2];
  const [ra, rb, rc, rd] = ({ 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] } as const)[rotation];
  const sideways = ra === 0;
  const [ox, oy] = sideways ? [Math.abs(cy), Math.abs(cx)] : [Math.abs(cx), Math.abs(cy)];
  const t = [ra, rb, rc, rd, ox - ra * cx - rc * cy, oy - rb * cx - rd * cy];
  return {
    width: sideways ? h : w,
    height: sideways ? w : h,
    convertToViewportPoint: (x: number, y: number): [number, number] => [t[0]! * x + t[2]! * y + t[4]!, t[1]! * x + t[3]! * y + t[5]!],
  };
}

const run = (transform: number[], str = 'The keeper climbed the stairs.') => ({ str, transform, width: 150, height: 12, hasEOL: false });

describe('PDF text, judged as it is shown on the page', () => {
  it('an ordinary page: upright text kept where it is; a sideways margin stamp dropped', () => {
    const page = viewport(0);
    expect(toItem(run([12, 0, 0, 12, 72, 700]), page)).toMatchObject({ x: 72, y: 700, width: 150, height: 12 });
    expect(toItem(run([0, 12, -12, 0, 20, 300], 'arXiv:1706.03762v7'), page)).toBeNull();
    // Italics lean a little, and stay.
    expect(toItem(run([12, 0, 2.5, 12, 72, 680]), page)).not.toBeNull();
  });

  it('a page rotated 90° whose text is turned back to read upright: kept, laid out upright', () => {
    const page = viewport(90);
    // Text running up the page in PDF space, which /Rotate 90 shows left to right.
    const item = toItem(run([0, 12, -12, 0, 100, 72]), page);
    expect(item).not.toBeNull();
    // 72 pt from the left edge of the page as shown (its long side is now the width).
    expect(item!.x).toBeCloseTo(72);
    expect(page.width).toBe(792);
    // Text written normally on that page shows sideways there: furniture now.
    expect(toItem(run([12, 0, 0, 12, 72, 700]), page)).toBeNull();
  });

  it('pages rotated 180° and 270° with text turned to match read upright too', () => {
    expect(toItem(run([-12, 0, 0, -12, 500, 100]), viewport(180))).not.toBeNull();
    expect(toItem(run([0, -12, 12, 0, 500, 700]), viewport(270))).not.toBeNull();
    // Upside down as shown is dropped, whatever the page says.
    expect(toItem(run([-12, 0, 0, -12, 500, 100]), viewport(0))).toBeNull();
  });

  it('text with no height of its own takes its size from how tall it is drawn', () => {
    const item = toItem({ str: 'x', transform: [0, 10, -10, 0, 100, 72], width: 5 }, viewport(90));
    expect(item?.height).toBeCloseTo(10);
  });
});
