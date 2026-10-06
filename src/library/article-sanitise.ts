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
 * SVG presentation attributes: the browser reads these as CSS, and a `url(…)` in one fetches like
 * an image. Holding attributes by *name* missed them, and a saved article made seven requests to
 * its site before "Load images". `src`, `background` and the rest of the address attributes are
 * not here — those are HTML, and are held for later rather than dropped (LOADS).
 */
const CSS_VALUED = new Set([
  'fill', 'stroke', 'filter', 'mask', 'clip-path', 'cursor', 'color-profile',
  'marker', 'marker-start', 'marker-mid', 'marker-end',
  'background-image', 'mask-image', 'shape-outside', 'list-style-image', 'border-image-source',
]);

/**
 * A CSS value as the *browser* reads it: escapes decoded and line continuations joined.
 *
 * Every spelling here is `url(…)` to CSS and fetches: `\75rl(…)`, `u\000072l(…)`, and a quoted
 * address split over two lines by a backslash before the newline. Each one got past a reader
 * looking for the literal text "url(".
 */
function decodeCss(value: string): string {
  return value
    // A backslash at the end of a line is a continuation: the browser joins the halves.
    .replace(/\\(?:\r\n|[\n\r\f])/g, '')
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    })
    .replace(/\\([^\n\r\f0-9a-f])/gi, '$1');
}

/** `url(#gradient)`: a reference inside this same document, which fetches nothing. */
const LOCAL_REF = /^url\(\s*(['"]?)#[\w:.-]+\1\s*\)/i;
/** A colour or a plain keyword — `red`, `#1a2b3c`, `rgb(0 0 0 / 50%)`, `none`, `currentColor`. */
const PLAIN_VALUE = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\s\w%.,/+-]*\)|[a-z-]+)$/i;

/**
 * Is this presentation attribute's value one the browser can read without fetching anything?
 *
 * An allowlist, not a search for the dangerous spellings: CSS has too many ways to write the same
 * address — escapes, line continuations, `image-set()` — and each patch for one spelling left the
 * next. A value is kept only when the whole of it is a local reference, a colour, or a keyword;
 * anything else is dropped, because a decoration is not content and nothing is lost by it.
 */
function safeCssValue(raw: string): boolean {
  const value = decodeCss(raw).trim();
  if (value === '') return true;
  const rest = value.replace(LOCAL_REF, '').trim();
  return rest === '' || PLAIN_VALUE.test(rest);
}

/** A `url(…)` anywhere in an attribute, as a last net over the attributes CSS_VALUED does not cover. */
const CSS_URL = /url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi;
/** CSS functions that fetch an image, besides url(). */
const CSS_FETCHING = /\b(?:-webkit-)?image-set\(|\bimage\(|\bcross-fade\(|\belement\(/i;

/** Would this attribute's value fetch from outside? For attributes that are not read as CSS. */
function outsideCssUrl(value: string): boolean {
  const css = decodeCss(value);
  if (CSS_FETCHING.test(css)) return true;
  for (const [, , url] of css.matchAll(CSS_URL)) {
    if (url && !url.trim().startsWith('#') && outside(url)) return true;
  }
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
      // Read as CSS by the browser: kept only if the whole value is local (see safeCssValue).
      if (CSS_VALUED.has(name)) {
        if (!safeCssValue(attr.value)) node.removeAttribute(attr.name);
        continue; // a decoration, not content: nothing to hold for later
      }
      if (outsideCssUrl(attr.value)) {
        node.removeAttribute(attr.name);
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
