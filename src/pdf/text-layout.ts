/**
 * Turning a PDF's text items into something worth reading aloud.
 *
 * A PDF has no paragraphs, no headings and no reading order — only glyphs at coordinates. What
 * pdf.js hands back is a flat list of runs per page, in the order the file happens to draw them,
 * which for a two-column layout means "left column line 1, right column line 1, …" or worse.
 * Reading that aloud verbatim produces the word salad the built-in viewers are famous for.
 *
 * So this module reconstructs the document the way a person sees it:
 *
 *   1. **Lines** — runs sharing a baseline, ordered left to right, with the gaps between runs
 *      turned back into spaces.
 *   2. **Columns** — vertical bands separated by whitespace no line crosses. Lines that span the
 *      whole width (titles, rules, full-width figures) split the page into sections, and inside a
 *      section each column is read top to bottom before the next one starts.
 *   3. **Blocks** — consecutive lines merged into paragraphs, list items and headings, using the
 *      signals a reader uses: vertical gaps, font size, indentation, bullet markers, and whether
 *      the previous line ended a sentence well short of the right margin.
 *   4. **Furniture removal** — running headers, footers and page numbers repeat across pages and
 *      are not part of the text; they are dropped rather than read out every page.
 *   5. **Hyphen repair** — "inter-\nview" becomes "interview", so the voice does not say
 *      "inter" and "view" as two words.
 *
 * Everything here is pure geometry over a minimal item shape, so it runs (and is tested) without
 * pdf.js or a browser. `load-pdf.ts` supplies the items.
 *
 * Coordinates are PDF user space: x grows right, **y grows up**, origin bottom-left.
 */

/** One text run as pdf.js reports it, reduced to what layout actually needs. */
export interface PdfTextItem {
  str: string;
  /** Left edge of the run (transform[4]). */
  x: number;
  /** Baseline (transform[5]). */
  y: number;
  width: number;
  /** Glyph height — pdf.js's `height`, i.e. the run's font size in user space. */
  height: number;
  fontName?: string;
  /** pdf.js's own "this run ended a line" flag. Advisory: geometry decides. */
  hasEOL?: boolean;
}

export interface PdfPageInput {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export type PdfBlockKind = 'heading' | 'paragraph' | 'list-item';

export interface PdfBlock {
  kind: PdfBlockKind;
  /** 1–3 for headings, by font size rank. Absent for other kinds. */
  level?: number;
  text: string;
  /** 1-based page this block starts on. */
  page: number;
  /**
   * The block's lines, in reading order, with the geometry needed to draw an invisible text
   * layer over a rendered page. Concatenating `lines[].text` reproduces `text` exactly, which is
   * what lets the same block be either reflowed HTML or an overlay on the page image.
   */
  lines: PdfLineBox[];
}

/** One line of a block, positioned in PDF user space (y is a baseline and grows *up*). */
export interface PdfLineBox {
  /** 1-based page this line is on. */
  page: number;
  /** Left edge. */
  x0: number;
  /** Right edge. */
  x1: number;
  /** Baseline. */
  y: number;
  /** Font size. */
  size: number;
  /**
   * The line's text *including* whatever joins it to the next line — a trailing space, or
   * nothing at all where a hyphenated word was repaired. Assembling the lines is therefore a
   * plain concatenation, with no rule for the caller to get wrong.
   */
  text: string;
}

export interface PdfOutline {
  /** Best-effort document title: the PDF's own metadata title, else the first big heading. */
  title: string;
  blocks: PdfBlock[];
}

interface Line {
  page: number;
  /** Baseline. */
  y: number;
  x0: number;
  x1: number;
  /** Dominant (largest) font size on the line. */
  size: number;
  text: string;
  /** True when every run on the line came from a font whose name suggests bold. */
  bold: boolean;
}

/** Marker characters that start a list item. `-` only counts when followed by a space. */
const BULLET = /^([•·▪◦‣∙*]|[-–—]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s|[ivxlc]+[.)]\s)/i;

/** A footnote/reference marker rather than words: superscript symbols and bare digits. */
const MARKER_ONLY = /^[*∗†‡§¶#\d\s.,]{1,4}$/;

const SENTENCE_END = /[.!?？。！]["'”’)\]]?\s*$/;

/** Trailing hyphen that a line break split a word across. */
const SOFT_HYPHEN_END = /([\p{L}\p{N}])[-‐­]$/u;

export interface LayoutOptions {
  /** Title from the PDF's metadata, when it has a usable one. */
  metadataTitle?: string;
}

/**
 * Reconstruct a readable document from per-page text items.
 *
 * The result is ordered for reading start to finish: page by page, section by section, column by
 * column.
 */
export function layoutPdfText(pages: PdfPageInput[], opts: LayoutOptions = {}): PdfOutline {
  const perPage = pages.map((page) => ({ page, lines: linesOf(page) }));
  const furniture = furnitureKeys(perPage);

  const ordered: Line[] = [];
  for (const { page, lines } of perPage) {
    ordered.push(...lines.filter((line) => !isFurniture(line, page, furniture)));
  }

  const bodySize = medianSize(ordered);
  const sized = blocksFrom(ordered, bodySize);
  const blocks = sized.map((b) => b.block);
  return { title: pickTitle(sized, opts.metadataTitle), blocks };
}

// ---- 1. lines --------------------------------------------------------------

/**
 * A page's lines, already in reading order.
 *
 * Columns have to be resolved *before* lines are formed, not after: in a two-column layout the
 * first line of the left column and the first line of the right column share a baseline, so
 * grouping by baseline alone would splice the two columns into one line — the classic
 * "Introduction Recurrent In this work we" salad. So the gutters are found from the runs
 * themselves, each run is assigned to a column, and lines are built within a column.
 */
function linesOf(page: PdfPageInput): Line[] {
  const items = page.items
    .filter((it) => it.str && it.str.trim() !== '')
    .sort((a, b) => b.y - a.y || a.x - b.x);
  if (items.length === 0) return [];

  const splits = findColumnSplits(
    items.map((it) => [it.x, it.x + (it.width || 0)] as const),
    0,
    page.width,
  );
  const bounds = [0, ...splits, page.width];
  /** Column index, or `null` for a run that crosses a gutter (a title, a spanning caption). */
  const columnOf = (item: PdfTextItem): number | null => {
    if (splits.length === 0) return 0;
    const x0 = item.x;
    const x1 = item.x + (item.width || 0);
    for (let i = 0; i < bounds.length - 1; i++) {
      if (x0 >= bounds[i]! - 0.5 && x1 <= bounds[i + 1]! + 0.5) return i;
    }
    return null;
  };

  // Sections are bounded by full-width runs: a two-column article can have a one-column
  // abstract above it, and each part is read in its own order.
  const out: Line[] = [];
  let section = new Map<number, PdfTextItem[]>();

  const flushSection = (): void => {
    for (const column of [...section.keys()].sort((a, b) => a - b)) {
      out.push(...linesWithin(section.get(column)!, page.pageNumber));
    }
    section = new Map();
  };

  let spanning: PdfTextItem[] = [];
  const flushSpanning = (): void => {
    if (spanning.length === 0) return;
    out.push(...linesWithin(spanning, page.pageNumber));
    spanning = [];
  };

  for (const item of items) {
    const column = columnOf(item);
    if (column == null) {
      // A run that crosses the gutter ends whatever columns were running above it.
      flushSection();
      spanning.push(item);
      continue;
    }
    flushSpanning();
    (section.get(column) ?? section.set(column, []).get(column)!).push(item);
  }
  flushSpanning();
  flushSection();
  return out;
}

/** Group runs that already belong to one column into baseline-ordered lines. */
function linesWithin(items: PdfTextItem[], page: number): Line[] {
  const lines: Line[] = [];
  let current: PdfTextItem[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const line = buildLine(current, page);
    if (line) lines.push(line);
    current = [];
  };

  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    // Same line if the baselines are within half the taller run's height. Superscripts sit a
    // couple of points above the baseline and still belong to the line they annotate.
    const ref = current[current.length - 1]!;
    const tolerance = Math.max(1, 0.5 * Math.max(ref.height || 0, item.height || 0));
    if (Math.abs(item.y - ref.y) <= tolerance) current.push(item);
    else {
      flush();
      current.push(item);
    }
  }
  flush();
  return lines;
}

function buildLine(runs: PdfTextItem[], page: number): Line | null {
  const ordered = [...runs].sort((a, b) => a.x - b.x);
  const size = Math.max(...ordered.map((r) => r.height || 0), 0);

  let text = '';
  let prevEnd: number | null = null;
  for (const run of ordered) {
    // Footnote markers and reference superscripts are noise when spoken: "Vaswani∗" reads as
    // "Vaswani star". Drop the tiny marker-only runs, keep genuine small text.
    const tiny = size > 0 && (run.height || 0) <= 0.72 * size;
    if (tiny && MARKER_ONLY.test(run.str)) {
      prevEnd = run.x + run.width;
      continue;
    }
    const gap = prevEnd == null ? 0 : run.x - prevEnd;
    if (text !== '' && gap > 0.18 * (run.height || size || 10) && !/\s$/.test(text)) text += ' ';
    text += run.str;
    prevEnd = run.x + run.width;
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return null;

  return {
    page,
    y: ordered[0]!.y,
    x0: Math.min(...ordered.map((r) => r.x)),
    x1: Math.max(...ordered.map((r) => r.x + (r.width || 0))),
    size: size || 10,
    bold: ordered.every((r) => /bold|black|heavy|semib/i.test(r.fontName ?? '')),
    text,
  };
}

// ---- 2. columns ------------------------------------------------------------

/**
 * Where a page's columns are divided, as x positions.
 *
 * Looking for a strip of pure whitespace does not survive contact with real documents: a figure,
 * a wide equation or a table caption reaches across the gutter of an otherwise perfectly ordinary
 * two-column paper, and one crossing run is enough to hide the gutter completely — which is how
 * a CVPR paper ends up read as "to ease the training 56-layer of networks that are substan…".
 *
 * So a split is judged statistically instead: a candidate x is a column boundary when almost
 * nothing crosses it (a few percent of runs may) and both sides carry a real share of the page.
 * Runs that do cross are treated as full-width, which is what they are.
 */
function findColumnSplits(
  spans: ReadonlyArray<readonly [number, number]>,
  from: number,
  to: number,
  depth = 0,
): number[] {
  const inside = spans.filter((s) => s[0] >= from - 0.5 && s[1] <= to + 0.5);
  // Too few runs to tell a column from a coincidence — a title page or a mostly-empty page.
  if (inside.length < 12 || depth > 1) return [];

  const width = to - from;
  let best: { x: number; crossing: number; balance: number } | null = null;

  // Only the middle of the region can be a column boundary; anything else is a margin.
  for (let f = 0.3; f <= 0.7; f += 0.01) {
    const x = from + f * width;
    let crossing = 0;
    let left = 0;
    let right = 0;
    for (const [x0, x1] of inside) {
      if (x0 < x - 2 && x1 > x + 2) crossing++;
      else if (x1 <= x) left++;
      else right++;
    }
    if (crossing > 0.04 * inside.length) continue;
    if (left < 0.25 * inside.length || right < 0.25 * inside.length) continue;
    const balance = Math.abs(left - right);
    if (!best || crossing < best.crossing || (crossing === best.crossing && balance < best.balance)) {
      best = { x, crossing, balance };
    }
  }
  if (!best) return [];

  // Newspapers and some reports run three or four columns; recurse once into each half.
  return [
    ...findColumnSplits(spans, from, best.x, depth + 1),
    best.x,
    ...findColumnSplits(spans, best.x, to, depth + 1),
  ].sort((a, b) => a - b);
}

// ---- 3. blocks -------------------------------------------------------------

interface SizedBlock {
  block: PdfBlock;
  /** Font size the block was set in — kept for title selection, not part of the output. */
  size: number;
}

function blocksFrom(lines: Line[], bodySize: number): SizedBlock[] {
  const groups: Line[][] = [];
  let group: Line[] = [];

  for (const line of lines) {
    if (group.length === 0) {
      group = [line];
      continue;
    }
    if (startsNewBlock(group, line, bodySize)) {
      groups.push(group);
      group = [line];
    } else {
      group.push(line);
    }
  }
  if (group.length > 0) groups.push(group);

  const headingSizes = distinctHeadingSizes(groups, bodySize);
  return groups
    .map((g) => {
      const block = toBlock(g, bodySize, headingSizes);
      return block ? { block, size: Math.max(...g.map((l) => l.size)) } : null;
    })
    .filter((b): b is SizedBlock => b !== null);
}

function startsNewBlock(group: Line[], line: Line, bodySize: number): boolean {
  const prev = group[group.length - 1]!;
  if (line.page !== prev.page) return true;

  // A different font size is a different thing: heading vs body, body vs caption.
  if (Math.abs(line.size - prev.size) > 0.14 * Math.max(line.size, prev.size)) return true;

  // Moving up the page, or into another column, means the run of lines ended.
  const gap = prev.y - line.y;
  if (gap < 0) return true;
  if (Math.abs(line.x0 - prev.x0) > 6 && line.x0 < prev.x0 - 6 && gap > 2 * line.size) return true;

  // A vertical gap noticeably bigger than single line spacing separates paragraphs.
  if (gap > 1.65 * Math.max(line.size, prev.size)) return true;

  // A bullet or a number starts a new item even when the spacing is tight.
  if (BULLET.test(line.text)) return true;

  // A finished sentence that stopped well short of the block's right margin, followed by an
  // indent, is the classic "new paragraph" shape in justified text.
  const right = Math.max(...group.map((l) => l.x1));
  const shortLast = prev.x1 < right - 0.12 * (right - Math.min(...group.map((l) => l.x0)));
  if (SENTENCE_END.test(prev.text) && (shortLast || line.x0 > prev.x0 + 0.02 * right)) return true;

  // Headings are short and rarely wrap; a long line after a heading-sized short line is new.
  if (prev.size > 1.15 * bodySize && SENTENCE_END.test(prev.text)) return true;

  return false;
}

function toBlock(group: Line[], bodySize: number, headingSizes: number[]): PdfBlock | null {
  const lines = joinLines(group);
  const text = assemble(lines);
  if (text === '') return null;

  const size = Math.max(...group.map((l) => l.size));
  const page = group[0]!.page;

  // "1. Introduction" is a heading; "1. Bring your passport." is a list item. Both start with a
  // number, so the tell is the shape of what follows: a heading is one short line that does not
  // finish a sentence. This test runs before the bullet test, which would otherwise swallow
  // every numbered section title in the document.
  const numbered = group.length === 1 && text.length <= 90 ? /^(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(text) : null;
  if (numbered && !SENTENCE_END.test(text) && text.split(/\s+/).length <= 9) {
    const depth = numbered[1]!.split('.').length;
    return { kind: 'heading', level: Math.min(3, depth), text, page, lines };
  }

  if (BULLET.test(group[0]!.text)) {
    // The marker is not spoken, so it is not part of the overlay text either — but the rest of
    // the first line keeps its own box, so the highlight still lands where the words are.
    const itemLines = withoutMarker(lines);
    return { kind: 'list-item', text: assemble(itemLines), page, lines: itemLines };
  }

  const isHeading =
    (size > 1.12 * bodySize || (group.every((l) => l.bold) && size >= bodySize)) &&
    text.length <= 200 &&
    group.length <= 3 &&
    !SENTENCE_END.test(text.replace(/\.$/, ''));
  if (isHeading) {
    const rank = headingSizes.indexOf(nearestSize(size, headingSizes));
    return { kind: 'heading', level: Math.min(3, Math.max(1, rank + 1)), text, page, lines };
  }

  return { kind: 'paragraph', text, page, lines };
}

/**
 * Join a block's lines, repairing words a line break hyphenated.
 *
 * The per-line pieces are kept alongside the joined string because the page-image view needs to
 * know which characters sit on which line: `lines[i].text` is exactly the slice of the result
 * that line contributed, separator included, so `lines.map(l => l.text).join('')` === `text`.
 */
function joinLines(group: Line[]): PdfLineBox[] {
  const lines: PdfLineBox[] = [];
  let out = '';
  for (const line of group) {
    const box = (piece: string): PdfLineBox => ({
      page: line.page,
      x0: line.x0,
      x1: line.x1,
      y: line.y,
      size: line.size,
      text: piece,
    });

    if (out === '') {
      out = line.text;
      lines.push(box(line.text));
      continue;
    }
    if (SOFT_HYPHEN_END.test(out) && /^[\p{Ll}]/u.test(line.text)) {
      // The hyphen belonged to the line break, not the word: drop it from the previous line's
      // piece so the two halves concatenate into one word.
      const prev = lines[lines.length - 1]!;
      prev.text = prev.text.replace(SOFT_HYPHEN_END, '$1');
      out = out.replace(SOFT_HYPHEN_END, '$1') + line.text;
    } else {
      const prev = lines[lines.length - 1]!;
      prev.text += ' ';
      out += ' ' + line.text;
    }
    lines.push(box(line.text));
  }
  return lines;
}

/**
 * The block's text, and the guarantee that the line pieces spell it.
 *
 * Trimming happens *on the pieces*, never on the joined string, so that
 * `lines.map(l => l.text).join('')` is the spoken text character for character. A highlight
 * offset that did not survive this would land on the wrong words.
 */
function assemble(lines: PdfLineBox[]): string {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first) first.text = first.text.replace(/^\s+/, '');
  if (last) last.text = last.text.replace(/\s+$/, '');
  return lines.map((l) => l.text).join('');
}

/** Drop a list marker from the first line's text, keeping the line's box. */
function withoutMarker(lines: PdfLineBox[]): PdfLineBox[] {
  const first = lines[0];
  if (!first) return lines;
  return [{ ...first, text: first.text.replace(BULLET, '') }, ...lines.slice(1)];
}

/** The distinct heading font sizes present, largest first — the levels of the document. */
function distinctHeadingSizes(groups: Line[][], bodySize: number): number[] {
  const sizes = new Set<number>();
  for (const g of groups) {
    const size = Math.round(Math.max(...g.map((l) => l.size)) * 2) / 2;
    if (size > 1.12 * bodySize) sizes.add(size);
  }
  return [...sizes].sort((a, b) => b - a);
}

function nearestSize(size: number, sizes: number[]): number {
  let best = sizes[0] ?? size;
  for (const s of sizes) if (Math.abs(s - size) < Math.abs(best - size)) best = s;
  return best;
}

/** The body font size: the most common line size, weighted by how much text it carries. */
function medianSize(lines: Line[]): number {
  if (lines.length === 0) return 10;
  const weight = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + line.text.length);
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

// ---- 4. running headers, footers and page numbers --------------------------

/**
 * Text that repeats in the same place across pages is furniture, not content.
 *
 * Keyed with digits masked so "Page 3 of 12" and "Page 4 of 12" count as the same header, and
 * required on several pages (or every page of a short document) before anything is dropped —
 * a two-page document must not lose a real heading that happens to appear twice.
 */
function furnitureKeys(perPage: Array<{ page: PdfPageInput; lines: Line[] }>): Set<string> {
  const seen = new Map<string, Set<number>>();
  for (const { page, lines } of perPage) {
    for (const line of lines) {
      if (!inMargin(line, page)) continue;
      const key = furnitureKey(line);
      (seen.get(key) ?? seen.set(key, new Set()).get(key)!).add(page.pageNumber);
    }
  }
  const threshold = Math.max(2, Math.ceil(perPage.length * 0.4));
  const keys = new Set<string>();
  for (const [key, pages] of seen) if (pages.size >= threshold) keys.add(key);
  return keys;
}

function furnitureKey(line: Line): string {
  return line.text.replace(/\d+/g, '#').toLowerCase().trim();
}

/** Top or bottom 8% of the page — where running heads and folios live. */
function inMargin(line: Line, page: PdfPageInput): boolean {
  const margin = 0.08 * page.height;
  return line.y <= margin || line.y >= page.height - margin;
}

function isFurniture(line: Line, page: PdfPageInput, keys: Set<string>): boolean {
  if (!inMargin(line, page)) return false;
  // A bare folio ("7", "- 7 -", "iv") is furniture even on a one-page document.
  if (/^[-–—\s]*(\d{1,4}|[ivxlcdm]{1,7})[-–—\s]*$/i.test(line.text)) return true;
  return keys.has(furnitureKey(line));
}

// ---- 5. title --------------------------------------------------------------

/**
 * The document's title.
 *
 * Not "the first heading": the first thing on a page is as likely to be a copyright notice, a
 * journal banner or a submission stamp. The title is the **biggest** short heading near the
 * front, which is what makes it look like a title in the first place.
 */
function pickTitle(sized: SizedBlock[], metadataTitle?: string): string {
  const meta = metadataTitle?.trim();
  // Producers routinely leave junk in the Title field ("Microsoft Word - final(3).doc").
  if (meta && meta.length >= 3 && !/^untitled|\.(docx?|pdf|tex|indd)\b/i.test(meta)) return meta;

  const candidates = sized
    .slice(0, 12)
    .filter((b) => b.block.kind === 'heading' && b.block.text.length >= 3 && b.block.text.length <= 150);
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (b.size > a.size ? b : a));
    return best.block.text;
  }

  const first = sized.find((b) => b.block.text.trim().length >= 3);
  return first ? first.block.text.slice(0, 120) : 'PDF document';
}

/**
 * Is `title` already part of the body text?
 *
 * Only a title from the PDF's *metadata* is text the body does not contain. When `pickTitle` had
 * to take it from the page — the biggest heading, or failing that the opening words — that text
 * is still in `blocks`, and a reader page that adds its own `<h1>` on top reads it aloud twice.
 * Compared whitespace-insensitively, and as a prefix of the first block, because the fallback
 * title is a 120-character slice of it.
 */
export function titleIsInBody(title: string, blocks: readonly { text: string }[]): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(title);
  if (!t) return true; // nothing worth a heading of its own
  if (blocks.slice(0, 12).some((b) => norm(b.text) === t)) return true;
  const first = blocks.find((b) => norm(b.text).length > 0);
  return first ? norm(first.text).startsWith(t) : false;
}
