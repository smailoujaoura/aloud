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
const LOADS = new Set(['src', 'href', 'xlink:href', 'poster', 'background', 'data', 'lowsrc', 'dynsrc', 'action', 'formaction', 'icon', 'manifest', 'archive', 'codebase', 'longdesc', 'imagesrcset']);
/**
 * A CSS `url(…)` inside any attribute. SVG presentation attributes — fill, stroke, filter, mask,
 * clip-path, marker-*, cursor — take them, and the browser fetches them like an image: holding
 * attributes by *name* missed them, and a saved article made seven requests to its site before
 * "Load images". So every attribute is looked at by its *content*.
 */
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
/** CSS functions that fetch an image, besides url(). */
const CSS_FETCHING = /\b(?:-webkit-)?image-set\(|\bimage\(|\bcross-fade\(|\belement\(/i;

/**
 * A CSS value as the browser reads it: escapes decoded. `\75rl(…)` and `u\000072l(…)` are both
 * `url(…)` to CSS, and looking for the literal text "url(" let them through — the browser then
 * fetched them before "Load images".
 */
function cssUnescape(value: string): string {
  return value
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/\\([^\n\r\f0-9a-f])/gi, '$1');
}

/**
 * Would this attribute value make the browser fetch something from outside? Decoded first. A
 * `url(#id)` pointing inside the SVG (a gradient, a clip path) is the one kind kept.
 */
function outsideCssUrl(value: string): boolean {
  const css = cssUnescape(value);
  if (CSS_FETCHING.test(css)) return true;
  for (const [, , url] of css.matchAll(CSS_URL)) {
    if (url && !url.trim().startsWith('#') && outside(url)) return true;
  }
  // Escapes that spell a function: nothing an article needs, and nothing to second-guess.
  if (css !== value && /[a-z-]\s*\(/i.test(css)) return true;
  return false;
}
/**
 * Does `value` point anywhere but Aloud's own pages? Decided by the browser's own URL parser, not
 * a pattern: browsers also accept `http:/host`, and `h<tab>ttp://host`, and fetch them like any
 * other address. Relative addresses resolve to Aloud's page, and are left alone.
 */
function outside(value: string): boolean {
  try {
    // Scheme and host, not `origin`: an extension page's origin can read as "null", and two
    // nulls compare equal — an address on another host would have counted as Aloud's own.
    const u = new URL(value, location.href);
    return u.protocol !== location.protocol || u.host !== location.host;
  } catch {
    return false; // not an address anything can load
  }
}
const HELD = 'data-aloud-held';
const HELD_PREFIX = 'data-aloud-held-';
const XLINK = 'http://www.w3.org/1999/xlink';

export function sanitised(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed
    .querySelectorAll(
      // <base> would re-point every relative address at the original site. SVG animation elements
      // can set an `href` after this has run, and the browser then loads it: an article read
      // aloud needs none of them.
      'script, style, link, meta, base, iframe, frame, object, embed, form, input, button, select, textarea, noscript, template, ' +
        'set, animate, animateMotion, animateTransform, animateColor, discard',
    )
    .forEach((n) => n.remove());
  for (const node of parsed.body.querySelectorAll('*')) {
    const tag = node.localName;
    const isLink = tag === 'a' || tag === 'area';
    let held = false;
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      // Aloud's own marks for held addresses: an article must not arrive with some already set.
      if (name === HELD || name.startsWith(HELD_PREFIX)) {
        node.removeAttribute(attr.name);
        continue;
      }
      const scriptUrl = (name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|data):/i.test(attr.value);
      // `ping` reports a click to a third party; `srcset` is a second list of image addresses.
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'srcset' || name === 'ping' || scriptUrl) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (outsideCssUrl(attr.value)) {
        node.removeAttribute(attr.name); // a decoration, not content: nothing to hold for later
        continue;
      }
      if (isLink && name === 'href') continue;
      if (LOADS.has(name) && outside(attr.value)) {
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
