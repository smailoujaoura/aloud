/**
 * What on a page is prose to read, decided against the *live* page: what is rendered, and what
 * is a control rather than text.
 *
 * The browser's own `checkVisibility()` was not enough. On a bilingual story (Webflow), each
 * paragraph's translation sits in a block with `opacity: 0; height: 0`, and the paragraph inside
 * it has its own box, opacity 1 and `visibility: visible` — so it passed, and the hidden English
 * was read between the Italian paragraphs. Opacity applies to a whole subtree and cannot be
 * undone below; so do `display: none`, the `hidden` attribute, `inert`, and a box clipped to
 * nothing. Those are checked up the ancestors here. `visibility` *can* be undone by a child, so
 * it is checked on the text's own parent, whose computed value is the inherited one.
 *
 * Controls: the same story puts a "Translate?" button under every paragraph — a styled `<div>`
 * with a pointer cursor, not a `<button>`. Native controls and ARIA widget roles are controls by
 * definition. A custom one needs more than one sign: short, standing on its own (not a word
 * inside a sentence), and clickable — a pointer cursor it sets itself rather than inherits, or
 * the attributes of something that toggles. No word lists, no site's class names: a short
 * paragraph of dialogue ("No!") has none of those signs and stays.
 *
 * Content below the viewport is rendered and stays readable: nothing here looks at position.
 * Results are cached per element for one pass (`new Eligibility()` per build).
 */

const NATIVE_CONTROLS = new Set(['BUTTON', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'LABEL']);

const WIDGET_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'tablist', 'textbox', 'toolbar',
]);

/** Attributes of something that toggles or controls another part of the page. */
const CONTROL_ATTRS = ['onclick', 'aria-controls', 'aria-expanded', 'aria-pressed', 'data-toggle', 'data-bs-toggle', 'data-action'];

/** Short enough to be a control's label rather than a sentence of prose. */
function isShortLabel(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  return t.split(/\s+/).length <= 5;
}

export class Eligibility {
  private readonly hiddenCache = new WeakMap<Element, boolean>();
  private readonly controlCache = new WeakMap<Element, boolean>();

  /** Is this text node drawn on the page at all? */
  rendered(node: Text): boolean {
    const parent = node.parentElement;
    if (!parent) return false;
    if (this.hidden(parent)) return false;
    // Text straight inside a closed <details>, beside its summary.
    if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) return false;
    const style = styleOf(parent);
    return !style || (style.visibility !== 'hidden' && style.visibility !== 'collapse');
  }

  /** Hidden for everything inside it: not rendered, invisible by opacity, or clipped to nothing. */
  hidden(el: Element): boolean {
    const known = this.hiddenCache.get(el);
    if (known !== undefined) return known;
    const result = selfHidden(el) || (el.parentElement ? this.hidden(el.parentElement) : false);
    this.hiddenCache.set(el, result);
    return result;
  }

  /** Inside a control, from `el` up to (not past) `root`. */
  inControl(el: Element, root: Element): boolean {
    for (let at: Element | null = el; at && at !== root.parentElement; at = at.parentElement) {
      if (this.control(at)) return true;
      if (at === root) break;
    }
    return false;
  }

  /** Is this element itself a control — native, an ARIA widget, or a custom one by its signs? */
  control(el: Element): boolean {
    const known = this.controlCache.get(el);
    if (known !== undefined) return known;
    const result = isControl(el);
    this.controlCache.set(el, result);
    return result;
  }
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  try {
    return el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
  } catch {
    return null;
  }
}

function selfHidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') return true;
  // The body of a closed <details>: the browser hides it with no style the element itself shows.
  const parent = el.parentElement;
  if (parent?.tagName === 'DETAILS' && !parent.hasAttribute('open') && el.tagName !== 'SUMMARY') return true;
  const style = styleOf(el);
  if (!style) return false;
  // `display: contents` has no box of its own, and hides nothing: its children are drawn.
  if (style.display === 'contents') return false;
  if (style.display === 'none') return true;
  if (Number.parseFloat(style.opacity) === 0 && !awaitingReveal(el, style)) return true;
  // Clipped to nothing: a box with no width or no height that does not let content overflow
  // (a collapsed accordion, a "visually hidden" helper). A zero-height box whose content
  // overflows visibly is not hidden by this — its content is drawn below it.
  const clips = /hidden|clip/.test(style.overflowX) || /hidden|clip/.test(style.overflowY);
  if (clips && el instanceof HTMLElement && (el.offsetWidth <= 1 || el.offsetHeight <= 1)) return true;
  if (/^inset\(\s*(50|100)%/.test(style.clipPath) || /rect\(\s*0(px)?,?\s+0(px)?,?\s+0(px)?,?\s+0(px)?\s*\)/.test(style.clip)) return true;
  return false;
}

/** Libraries that fade text in as it scrolls into view mark it with one of these. */
const REVEAL_MARK = /^(data-aos|data-sal|data-scroll|data-animate|data-reveal|data-sr)/;
const REVEAL_CLASS = /(^|\s)(aos-|wow|reveal|fade-?in|animate__|sal-|scroll-?reveal)/i;

/**
 * Transparent, but only until it is scrolled to. Scroll-reveal pages (AOS and the like) keep every
 * paragraph below the first screen at opacity 0 and fade each in as it arrives — reading only the
 * first screen of such a page was the result of treating them as hidden. Such a paragraph is a
 * full-size box in the flow of the page, and below what is on screen. A collapsed translation has
 * no height; a tooltip or menu floats above the page; text faded out on screen is meant unseen:
 * those stay hidden.
 */
function awaitingReveal(el: Element, style: CSSStyleDeclaration): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.offsetWidth <= 1 || el.offsetHeight <= 1) return false;
  if (style.position === 'absolute' || style.position === 'fixed') return false;
  if ([...el.attributes].some((a) => REVEAL_MARK.test(a.name)) || REVEAL_CLASS.test(el.className)) return true;
  const view = el.ownerDocument.defaultView;
  return !!view && el.getBoundingClientRect().top >= view.innerHeight;
}

/** Text in this element is drawn invisibly (`visibility`), unless a child makes itself visible. */
export function invisible(el: Element): boolean {
  const v = styleOf(el)?.visibility;
  return v === 'hidden' || v === 'collapse';
}

function isControl(el: Element): boolean {
  if (NATIVE_CONTROLS.has(el.tagName)) return true;
  const role = el.getAttribute('role');
  if (role && WIDGET_ROLES.has(role.trim().toLowerCase())) return true;
  // Links are prose: an inline link is part of its sentence, and a heading may be a link.
  if (el.tagName === 'A' || el.closest('a') || el.querySelector('a')) return false;

  const text = el.textContent ?? '';
  if (!isShortLabel(text)) return false;

  // It must stand on its own: the whole text of its line, not a word inside a sentence.
  const parent = el.parentElement;
  const style = styleOf(el);
  const standalone =
    !!style &&
    (/^(block|flex|grid|inline-block|inline-flex|list-item|table)$/.test(style.display) ||
      (parent ? (parent.textContent ?? '').trim() === text.trim() : true));
  if (!standalone) return false;

  // Clickable by its own doing: a pointer it sets rather than inherits, or toggling attributes.
  const ownPointer = style?.cursor === 'pointer' && (!parent || styleOf(parent)?.cursor !== 'pointer');
  const toggles =
    CONTROL_ATTRS.some((a) => el.hasAttribute(a)) ||
    (el.hasAttribute('tabindex') && Number(el.getAttribute('tabindex')) >= 0);
  if (ownPointer || toggles) return true;

  // A label beside its control: short text whose sibling is a clickable thing with no text of its
  // own (a switch drawn in CSS), or a native/ARIA control.
  if (parent) {
    for (const sibling of Array.from(parent.children)) {
      if (sibling === el) continue;
      const siblingText = (sibling.textContent ?? '').trim();
      const siblingRole = sibling.getAttribute('role')?.trim().toLowerCase();
      if (NATIVE_CONTROLS.has(sibling.tagName) || (siblingRole && WIDGET_ROLES.has(siblingRole))) return true;
      if (!siblingText && styleOf(sibling)?.cursor === 'pointer') return true;
    }
  }
  return false;
}
