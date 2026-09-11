/**
 * Drawing a PDF as itself, with an invisible text layer the reader can highlight.
 *
 * Neither browser lets an extension into its own PDF viewer — Chromium renders PDFs in an
 * internal plugin frame whose document contains no text at all, and Firefox uses a privileged
 * pdf.js viewer that content scripts may not touch. So the only way to read a PDF *as a PDF*,
 * rather than as reflowed text, is to draw the pages ourselves.
 *
 * Each page becomes a `<canvas>` with the real rendering, and over it goes a text layer of
 * transparent, absolutely-positioned lines. That text layer is ordinary DOM text, so everything
 * the reader already does works on it untouched: `buildTextIndex` walks it, sentence highlighting
 * paints `Range`s over it (landing exactly on the words in the image beneath), tap-to-seek hit
 * tests it, and the scroll modes scroll it.
 *
 * Two details decide whether that actually works:
 *
 *  - **DOM order must be reading order.** pdf.js's own `TextLayer` emits spans in the PDF's raw
 *    content order, which on a two-column page runs across the gutter — the exact thing
 *    `text-layout.ts` exists to fix. So the spans are emitted from *our* ordered blocks instead,
 *    wrapped in real `<p>` / `<h2>` / `<li>` elements so block boundaries survive too.
 *  - **A line's box must match the glyphs underneath it.** The line is positioned at its
 *    baseline and then scaled horizontally so its measured width equals the width the PDF says
 *    it occupies. Without that, a highlight drifts further from the words the further along the
 *    line it goes.
 */
import type { PdfBlock, PdfLineBox } from './text-layout';
import type { PdfPageView } from './load-pdf';

/**
 * Where the baseline sits inside a line box, as a fraction of the font size.
 *
 * A PDF positions text by its baseline; CSS positions a line box by its top. The distance
 * between them depends on the font's own ascent and descent, so it is measured from the font the
 * layer actually uses rather than assumed — guessing puts the highlight a quarter of a line above
 * the words. Measured once: it cannot change without the stylesheet changing.
 */
let baselineRatio: number | null = null;

function measureBaselineRatio(within: HTMLElement): number {
  if (baselineRatio != null) return baselineRatio;

  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;font-size:100px;line-height:1;white-space:pre';
  const strut = document.createElement('span');
  // A zero-size inline-block sits *on* the baseline, so its bottom edge is where the baseline is.
  strut.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  probe.append(document.createTextNode('Hxg'), strut);
  within.append(probe);

  const ratio = (strut.getBoundingClientRect().bottom - probe.getBoundingClientRect().top) / 100;
  probe.remove();

  // A detached or display:none container measures 0; don't cache a useless answer.
  if (!(ratio > 0.2 && ratio < 1.5)) return 0.85;
  baselineRatio = ratio;
  return ratio;
}

/** Tag for a block, matching what the reflowed view produces so both read identically. */
function tagFor(block: PdfBlock): string {
  if (block.kind === 'heading') return `h${Math.min(3, Math.max(2, (block.level ?? 2) + 1))}`;
  if (block.kind === 'list-item') return 'li';
  return 'p';
}

interface PendingLine {
  el: HTMLElement;
  /** The line's baseline, in CSS pixels from the top of the page. */
  baseline: number;
  fontSize: number;
  /** Width in CSS pixels this line occupies on the page. */
  target: number;
  /** Characters to measure — the line's text without the separator that joins it to the next. */
  measured: number;
}

/**
 * Build one page's text layer from the blocks whose lines fall on it.
 *
 * Returns the element, unattached. `finish()` must be called once it is in the document: the
 * horizontal scaling needs real measurements, and those need layout.
 */
export function buildTextLayer(
  view: PdfPageView,
  groups: Array<{ block: PdfBlock; lines: PdfLineBox[] }>,
): { el: HTMLElement; finish: () => void } {
  const layer = document.createElement('div');
  layer.className = 'text-layer';
  const pending: PendingLine[] = [];

  let list: HTMLElement | null = null;
  for (const { block, lines } of groups) {
    const tag = tagFor(block);
    // Consecutive list items share one <ul>, so the reader sees a list rather than loose lines.
    if (tag === 'li') {
      if (!list) {
        list = document.createElement('ul');
        layer.append(list);
      }
    } else {
      list = null;
    }

    const el = document.createElement(tag);
    for (const line of lines) pending.push(addLine(el, view, line));
    (list ?? layer).append(el);
  }

  return {
    el: layer,
    finish() {
      // Everything here needs real measurements, so it must run with the layer in the document
      // and visible — one forced layout for the whole page rather than one per line.
      const ascent = measureBaselineRatio(layer);
      for (const line of pending) place(line, ascent);
    },
  };
}

function addLine(parent: HTMLElement, view: PdfPageView, line: PdfLineBox): PendingLine {
  const [x, baseline] = view.toViewport(line.x0, line.y);
  const [right] = view.toViewport(line.x1, line.y);
  const fontSize = Math.max(1, line.size * pageScale(view, line));

  const el = document.createElement('span');
  el.textContent = line.text;
  el.style.left = `${x}px`;
  el.style.fontSize = `${fontSize}px`;
  parent.append(el);

  return {
    el,
    baseline,
    fontSize,
    target: Math.abs(right - x),
    measured: line.text.replace(/\s+$/, '').length,
  };
}

/** Recover the render scale from the page view, which knows its own size in both spaces. */
function pageScale(view: PdfPageView, line: PdfLineBox): number {
  const [x0] = view.toViewport(line.x0, line.y);
  const [x1] = view.toViewport(line.x0 + 100, line.y);
  const s = Math.abs(x1 - x0) / 100;
  return s > 0 ? s : 1;
}

/**
 * Sit the line on its baseline, and stretch it to the width the PDF gives it.
 *
 * The layer is drawn in one ordinary font, not the document's, so its natural width is never the
 * right one. Measuring the text *without* its trailing separator matters: that space is there to
 * make the lines concatenate into the spoken text, and including it in the measurement would
 * squeeze every line by about a character.
 */
function place({ el, baseline, fontSize, target, measured }: PendingLine, ascent: number): void {
  el.style.top = `${baseline - fontSize * ascent}px`;

  const node = el.firstChild;
  if (!node || target <= 0 || measured <= 0) return;

  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, measured);
  const natural = range.getBoundingClientRect().width;
  if (natural <= 0) return;

  el.style.transform = `scaleX(${target / natural})`;
}
