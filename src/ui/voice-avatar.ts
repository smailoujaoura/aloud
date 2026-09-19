/**
 * The stand-in avatar: one drawing, the same for every voice without a portrait.
 *
 * The best voices have a photographic portrait (voice-portraits.ts) and are meant to be
 * recognised by it. Everything else gets *this* — deliberately one identical, plainly generic
 * silhouette rather than a per-voice illustration, so a face in the list always means "this is
 * one of the good ones" and never "here is what this voice looks like".
 */

const NS = 'http://www.w3.org/2000/svg';

/** `en_GB-alba-medium` -> `alba`. */
export function piperVoiceName(id: string): string {
  const parts = id.split('-');
  return parts.length >= 3 ? parts.slice(1, -1).join('-') : (parts[1] ?? id);
}

/** The stand-in avatar, `size` pixels square. Identical for every voice that has no portrait. */
export function genericAvatar(doc: Document, size = 40): SVGSVGElement {
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.generic = 'true';

  const node = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const el = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };

  // A flat grey badge with a head-and-shoulders glyph: reads as "no picture", not as a person.
  svg.append(node('rect', { width: 64, height: 64, fill: 'var(--surface-3, #d9d9de)' }));
  svg.append(node('circle', { cx: 32, cy: 25, r: 10, fill: 'var(--fg-faint, #9a9aa3)' }));
  svg.append(
    node('path', {
      d: 'M12 56c0-11 9-18 20-18s20 7 20 18z',
      fill: 'var(--fg-faint, #9a9aa3)',
    }),
  );
  return svg;
}
