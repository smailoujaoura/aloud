// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { backgroundUnder, readableTextColor, parseColor } from '@/highlight/contrast';

const YELLOW = parseColor('rgba(255, 214, 10, 0.45)')!;

function at(selector: string) {
  return document.querySelector(selector)!;
}

describe('backgroundUnder', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('style', '');
    document.body.setAttribute('style', '');
  });

  it('finds the nearest ancestor that actually paints', () => {
    document.body.innerHTML = '<div style="background: rgb(240, 240, 240)"><p><span id="t">text</span></p></div>';
    expect(backgroundUnder(at('#t'), window)).toEqual([240, 240, 240]);
  });

  it('blends translucent layers down onto it', () => {
    document.body.innerHTML =
      '<div style="background: rgb(0, 0, 0)"><div style="background: rgba(255, 255, 255, 0.5)"><span id="t">text</span></div></div>';
    expect(backgroundUnder(at('#t'), window)).toEqual([128, 128, 128]);
  });

  it('falls back to the canvas when nothing paints', () => {
    document.body.innerHTML = '<p><span id="t">text</span></p>';
    expect(backgroundUnder(at('#t'), window)).toEqual([255, 255, 255]);
  });

  it('reads a dark page from the element that sets it', () => {
    document.body.setAttribute('style', 'background: rgb(18, 18, 18)');
    document.body.innerHTML = '<p><span id="t">text</span></p>';
    const background = backgroundUnder(at('#t'), window);
    expect(background).toEqual([18, 18, 18]);
    // …and that is what makes the highlight unreadable for the page's own light grey text.
    expect(readableTextColor(parseColor('rgb(230, 230, 230)')!, background, YELLOW)).toBe('#ffffff');
  });
});
