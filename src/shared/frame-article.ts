/**
 * The article is in a frame: pages that only wrap someone else's page.
 *
 * A Claude artifact's page holds 81 characters of its own (a title and some buttons) and shows
 * the artifact in a sandboxed frame from another site, covering 95% of the window. Aloud read the
 * top page only, so it said "This page doesn't look like an article." Embedded reports, newsletter
 * readers and document previews do the same. Here: which frame is the page's real content, and
 * which permission reading it needs. The reader then runs inside that frame
 * (entrypoints/background.ts: readInFrame).
 */

/** A frame showing at least this share of the window can be what the page is for. */
const MIN_SHARE = 0.35;

export interface FrameBox {
  src: string;
  width: number;
  height: number;
  visible: boolean;
}

/**
 * The frame that is the page's content, or null: the largest visible web frame covering at least
 * a third of the window. Ads, players and widgets are smaller than that.
 */
export function articleFrame<T extends FrameBox>(frames: readonly T[], viewWidth: number, viewHeight: number): T | null {
  const window = Math.max(1, viewWidth * viewHeight);
  let best: T | null = null;
  let bestArea = 0;
  for (const f of frames) {
    if (!f.visible || !/^https?:\/\//i.test(f.src)) continue;
    const area = Math.max(0, f.width) * Math.max(0, f.height);
    if (area / window < MIN_SHARE || area <= bestArea) continue;
    best = f;
    bestArea = area;
  }
  return best;
}

/** The frames of `doc` as boxes, as seen in its window now. */
export function framesOf(doc: Document): Array<FrameBox & { element: HTMLIFrameElement }> {
  const view = doc.defaultView;
  return [...doc.querySelectorAll('iframe')].map((element) => {
    const r = element.getBoundingClientRect();
    const style = view?.getComputedStyle(element);
    const onScreen = r.bottom > 0 && r.right > 0 && r.top < (view?.innerHeight ?? 0) && r.left < (view?.innerWidth ?? 0);
    const shown = !!style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.05;
    return { element, src: element.src, width: r.width, height: r.height, visible: onScreen && shown };
  });
}

/**
 * The permission to ask for, to read a frame from `url`: its site. A host whose first label is
 * random (one per document: `9c6fc9bc-6fa6-…-3809ae731c25.frame.claudeusercontent.com`) is asked
 * for with all its siblings, or every new artifact would ask again.
 */
export function framePattern(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const labels = u.hostname.split('.');
  const first = labels[0] ?? '';
  const random = labels.length >= 3 && first.length >= 16 && /\d/.test(first) && /^[a-z0-9-]+$/i.test(first);
  const host = random ? `*.${labels.slice(1).join('.')}` : u.hostname;
  return `${u.protocol}//${host}/*`;
}

/** The site to name to the reader: `frame.claudeusercontent.com`, not the random label before it. */
export function frameSite(url: string): string {
  const pattern = framePattern(url);
  if (!pattern) return '';
  return pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, '').replace(/^\*\./, '');
}

/** Is `href` (a frame's address as it is now) the frame that was found, at `src`? */
export function sameFrame(href: string, src: string): boolean {
  try {
    const a = new URL(href);
    const b = new URL(src);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}
