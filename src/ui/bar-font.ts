/**
 * The reading bar's typeface: Inter (SIL OFL, public/fonts/Inter-OFL.txt), the same face as
 * Aloud's own pages.
 *
 * The bar lives in a page, and the extension's font files are deliberately not reachable from
 * pages (anything web-accessible lets a site recognise Aloud). So the Latin subset is bundled into
 * the reader as bytes and registered with the page's font set while the reader is open, under a
 * name of its own. From bytes, not a URL: a site's content-security policy can block a font *URL*
 * (data: included), never a FontFace made from an ArrayBuffer. If anything refuses, the bar keeps
 * its system font stack.
 */
import interLatin from '../../public/fonts/inter-latin.woff2?inline';

export const BAR_FONT_FAMILY = 'Aloud Inter';

let face: FontFace | null = null;

export function loadBarFont(doc: Document): void {
  if (face || typeof FontFace === 'undefined') return;
  try {
    const base64 = interLatin.slice(interLatin.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    face = new FontFace(BAR_FONT_FAMILY, bytes.buffer, { weight: '100 900', display: 'swap' });
    doc.fonts.add(face);
    void face.load().catch(() => undefined);
  } catch {
    face = null;
  }
}

/** Take the face back out of the page's font set when the reader closes. */
export function unloadBarFont(doc: Document): void {
  if (!face) return;
  try {
    doc.fonts.delete(face);
  } catch {
    /* the page has gone */
  }
  face = null;
}
