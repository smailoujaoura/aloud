/**
 * Small DOM builders shared by the control bar and the options page.
 *
 * Everything here builds nodes with `createElement` rather than `innerHTML`. That is not just
 * style: an extension that assigns markup strings fails `web-ext lint` and gets flagged in AMO
 * review, and the control bar in particular is injected into pages we do not control.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text != null) node.textContent = text;
  return node;
}

/** An inline SVG icon from a list of path `d` attributes, sized to the current font colour. */
export function svgIcon(doc: Document, paths: string[], size = 16): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
