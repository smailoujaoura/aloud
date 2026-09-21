import { describe, expect, it } from 'vitest';
import { blend, contrastRatio, parseColor, readableTextColor, toneOf, washFor } from '@/highlight/contrast';

const YELLOW = parseColor('rgba(255, 214, 10, 0.45)')!;

describe('parseColor', () => {
  it('reads the forms a browser reports and a settings page writes', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ rgb: [255, 0, 0], alpha: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ rgb: [0, 0, 0], alpha: 0.5 });
    expect(parseColor('rgb(10 20 30 / 40%)')).toEqual({ rgb: [10, 20, 30], alpha: 0.4 });
    expect(parseColor('#abc')).toEqual({ rgb: [170, 187, 204], alpha: 1 });
    expect(parseColor('#aabbccdd')!.alpha).toBeCloseTo(0.867, 2);
    expect(parseColor('transparent')!.alpha).toBe(0);
    expect(parseColor('rebeccapurple')).toBeNull();
  });
});

describe('blend and contrast', () => {
  it('paints one colour over another', () => {
    expect(blend({ rgb: [255, 255, 255], alpha: 0.5 }, [0, 0, 0])).toEqual([128, 128, 128]);
  });

  it('measures contrast the way WCAG does', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
  });
});

describe('readableTextColor', () => {
  it('leaves ordinary black-on-white text alone', () => {
    expect(readableTextColor(parseColor('rgb(20, 20, 20)')!, [255, 255, 255], YELLOW)).toBeNull();
  });

  it('rescues light text on a dark page, where the wash and the letters converge', () => {
    // A dark page: #e6e6e6 letters on #121212. Yellow at 45% over near-black is a mid olive that
    // pale letters disappear into; white clears the bar there, black does not.
    expect(readableTextColor(parseColor('rgb(230, 230, 230)')!, [18, 18, 18], YELLOW)).toBe('#ffffff');
  });

  it('rescues pale grey text on a light page', () => {
    expect(readableTextColor(parseColor('rgb(170, 170, 170)')!, [255, 255, 255], YELLOW)).toBe('#101014');
  });

  it('accounts for the page’s own translucent text', () => {
    expect(readableTextColor(parseColor('rgba(0, 0, 0, 0.25)')!, [255, 255, 255], YELLOW)).toBe('#101014');
  });

  it('picks white when the wash is dark', () => {
    expect(readableTextColor(parseColor('rgb(90, 90, 90)')!, [10, 10, 10], parseColor('rgba(20, 20, 120, 0.8)')!)).toBe('#ffffff');
  });

  it('keeps the page’s colour when nothing would read better', () => {
    // Black letters on a mid grey wash: neither black nor white clears the bar, and black is
    // already the better of the two.
    expect(readableTextColor(parseColor('rgb(0, 0, 0)')!, [128, 128, 128], parseColor('rgba(128, 128, 128, 1)')!)).toBeNull();
  });
});

describe('washFor', () => {
  it('leaves the colour alone on a light page', () => {
    expect(washFor(YELLOW, 'light')).toEqual(YELLOW);
  });

  it('turns a dark page’s wash into a glow the page’s own light text still reads on', () => {
    const page: [number, number, number] = [18, 18, 18];
    expect(toneOf(page)).toBe('dark');
    expect(toneOf([250, 250, 250])).toBe('light');
    const text = parseColor('rgb(230, 230, 230)')!;
    // Before: the full-strength wash needs its letters swapped to stay readable.
    expect(readableTextColor(text, page, YELLOW)).not.toBeNull();
    // After: the adapted wash leaves the page's own colour readable as it is.
    expect(readableTextColor(text, page, washFor(YELLOW, 'dark'))).toBeNull();
    // …and it is still visibly a highlight against the page.
    expect(contrastRatio(blend(washFor(YELLOW, 'dark'), page), page)).toBeGreaterThan(1.8);
  });
});
