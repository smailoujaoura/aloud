/**
 * Keeping highlighted text readable on someone else's page.
 *
 * The sentence highlight is a translucent colour painted *behind* text Aloud does not control.
 * Most of the time that is fine. It is not fine when the page's own text is already close to the
 * highlight: pale grey on a light page, or — much worse — a dark page, where a yellow wash at 45%
 * turns light grey letters into almost the same tone as what is behind them, and the sentence
 * being read becomes the hardest line to read.
 *
 * So: work out what colour the letters actually end up sitting on (the page's background with the
 * highlight blended over it), measure the contrast the page's own text has against *that*, and
 * only when it falls below the readable threshold give those letters a colour of their own —
 * black or white, whichever the blend can carry. Text that is already readable is left alone,
 * because the page's own colour is information too (a link, a heading, code).
 */

export type Rgb = [number, number, number];
export interface Rgba {
  rgb: Rgb;
  alpha: number;
}

/** WCAG AA for body text. Below this, letters on the highlight are hard work. */
export const READABLE_CONTRAST = 4.5;

/** `rgb(1 2 3)`, `rgba(1,2,3,.4)`, `#abc`, `#aabbcc`, `transparent`. Null for anything else. */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  if (!text || text === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1]!;
    const wide = digits.length <= 4;
    const part = (i: number): number => {
      const chunk = wide ? digits[i]!.repeat(2) : digits.slice(i * 2, i * 2 + 2);
      return parseInt(chunk, 16);
    };
    const alpha = digits.length === 4 || digits.length === 8 ? part(3) / 255 : 1;
    return { rgb: [part(0), part(1), part(2)], alpha };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (v: string): number => (v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v));
  const alphaPart = parts[3];
  return {
    rgb: [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)],
    alpha: alphaPart == null ? 1 : alphaPart.endsWith('%') ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart),
  };
}

/** `over` painted on `under`, both opaque afterwards. */
export function blend(over: Rgba, under: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, over.alpha));
  return [0, 1, 2].map((i) => Math.round(over.rgb[i]! * a + under[i]! * (1 - a))) as Rgb;
}

/** WCAG relative luminance. */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const channel = v / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The colour highlighted letters should take, or null to leave the page's own colour alone.
 *
 * `text` is the page's colour for those letters, `pageBackground` what they sit on now, and
 * `highlight` the wash Aloud paints between the two.
 */
export function readableTextColor(text: Rgba, pageBackground: Rgb, highlight: Rgba, threshold = READABLE_CONTRAST): string | null {
  const behind = blend(highlight, pageBackground);
  // Text with its own translucency ends up mixed with what is behind it too.
  const letters = blend(text, behind);
  if (contrastRatio(letters, behind) >= threshold) return null;
  const black = contrastRatio([0, 0, 0], behind);
  const white = contrastRatio([255, 255, 255], behind);
  // Only override when it is actually an improvement — on a mid-tone wash neither may reach the
  // threshold, and swapping to a colour that is no better just loses the page's meaning.
  const best = Math.max(black, white);
  if (best <= contrastRatio(letters, behind)) return null;
  return black >= white ? '#101014' : '#ffffff';
}


/**
 * What `element`'s text actually sits on: the nearest ancestor that paints a background, with any
 * translucent layers above it blended in. A page that paints nothing ends on the canvas, which is
 * white unless the reader's browser is in dark mode.
 */
export function backgroundUnder(element: Element, view: Window): Rgb {
  let layer: Element | null = element;
  const stack: Rgba[] = [];
  while (layer) {
    const color = parseColor(view.getComputedStyle(layer).backgroundColor);
    if (color && color.alpha > 0) {
      stack.push(color);
      if (color.alpha >= 1) break;
    }
    layer = layer.parentElement;
  }
  const opaque = stack.length > 0 && stack[stack.length - 1]!.alpha >= 1;
  let base: Rgb = opaque ? stack.pop()!.rgb : view.matchMedia?.('(prefers-color-scheme: dark)').matches ? [18, 18, 18] : [255, 255, 255];
  for (const above of stack.reverse()) base = blend(above, base);
  return base;
}
