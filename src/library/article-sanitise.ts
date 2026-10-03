/**
 * A saved article's HTML, made safe and silent.
 *
 * Safe: Readability's output minus anything that could run or submit — no scripts, frames, forms
 * or event handlers, and every link opening in a new tab. Parsed with DOMParser into an inert
 * document and imported node by node, never assigned as markup to the live page.
 *
 * Silent: an article saved for offline reading carries its images, audio, video and SVG pictures
 * as addresses on someone else's server, and the browser fetches them the moment they are in the
 * page — a request to that host, with a time, from a page Aloud says runs on your device. So no
 * element keeps an outside address in any attribute that loads something; each one is held, and
 * put back only when the reader presses "Load images" (`releaseHeld`). Only links keep theirs:
 * following a link is the reader's own act.
 */

/** Attributes that make the browser fetch something by themselves. */
const LOADS = new Set(['src', 'href', 'xlink:href', 'poster', 'background', 'data', 'lowsrc', 'dynsrc']);
/** An address on another host: `https://…`, `http://…` or `//…`. Relative ones resolve to Aloud's own pages. */
const OUTSIDE = /^\s*(?:https?:)?\/\//i;
const HELD = 'data-aloud-held';
const HELD_PREFIX = 'data-aloud-held-';
const XLINK = 'http://www.w3.org/1999/xlink';

export function sanitised(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed
    .querySelectorAll(
      // <base> would re-point every relative address at the original site.
      'script, style, link, meta, base, iframe, frame, object, embed, form, input, button, select, textarea, noscript, template',
    )
    .forEach((n) => n.remove());
  for (const node of parsed.body.querySelectorAll('*')) {
    const tag = node.localName;
    const isLink = tag === 'a' || tag === 'area';
    let held = false;
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const scriptUrl = (name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|data):/i.test(attr.value);
      // `ping` reports a click to a third party; `srcset` is a second list of image addresses.
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'srcset' || name === 'ping' || scriptUrl) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (isLink && name === 'href') continue;
      if (LOADS.has(name) && OUTSIDE.test(attr.value)) {
        if (name === 'poster') {
          node.removeAttribute(attr.name); // a still frame is not worth a request
          continue;
        }
        node.setAttribute(HELD_PREFIX + name.replace(':', '-'), attr.value);
        node.removeAttribute(attr.name);
        held = true;
      }
    }
    if (held) {
      node.setAttribute(HELD, '');
      if (tag === 'img') node.setAttribute('alt', node.getAttribute('alt') || 'Image not loaded');
    }
    if (tag === 'img') node.setAttribute('loading', 'lazy');
    if (tag === 'video' || tag === 'audio') {
      node.setAttribute('preload', 'none');
      node.removeAttribute('autoplay');
    }
    if (isLink) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }
  const fragment = document.createDocumentFragment();
  for (const child of [...parsed.body.childNodes]) fragment.appendChild(document.importNode(child, true));
  return fragment;
}

/** How many elements under `root` are waiting for "Load images". */
export function heldCount(root: ParentNode): number {
  return root.querySelectorAll(`[${HELD}]`).length;
}

/** "Load images": put every held address back where it was. */
export function releaseHeld(root: ParentNode): void {
  for (const node of root.querySelectorAll(`[${HELD}]`)) {
    for (const attr of [...node.attributes]) {
      if (!attr.name.startsWith(HELD_PREFIX)) continue;
      const name = attr.name.slice(HELD_PREFIX.length);
      node.removeAttribute(attr.name);
      if (name === 'xlink-href') node.setAttributeNS(XLINK, 'xlink:href', attr.value);
      else node.setAttribute(name, attr.value);
    }
    node.removeAttribute(HELD);
  }
}
