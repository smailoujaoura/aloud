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

/**
 * A language tag for a phonetic transcription: BCP 47's `fonipa` (and its kin), or `IPA` as
 * Wikipedia also writes it (`fr-IPA`, `it-Latn-fonipa`). Notation, not words: a voice can only
 * garble "[a.lõ.z‿ɑ̃.fɑ̃ də la pa.tʁi.ə]", and it was read with the French voice.
 */
const NOTATION = /(^|-)(fonipa|fonupa|fonapa|fonxsamp|fonkirsh|ipa)(-|$)/i;

export class Eligibility {
  /**
   * @param skip Selector for text never to be said even where it shows — a citation marker, an
   *   infobox, a share bar (extract/site-rules.ts). '' for none.
   */
  constructor(private readonly skip = '') {}

  private readonly skipCache = new WeakMap<Element, boolean>();
  private readonly hiddenCache = new WeakMap<Element, boolean>();
  private readonly controlCache = new WeakMap<Element, boolean>();
  private readonly notationCache = new WeakMap<Element, boolean>();
  /** The blocks of prose this page has already faded in (fadedIn), found once a pass. */
  private faded: HTMLElement[] | null = null;
  private readonly fadesIn = (el: HTMLElement): boolean => revealedLike(el, (this.faded ??= fadedIn(el.ownerDocument)));

  /** Is this text drawn, and words to say rather than a phonetic transcription? */
  spoken(node: Text): boolean {
    const parent = node.parentElement;
    return this.rendered(node) && !(parent && (this.notation(parent) || this.skipped(parent)));
  }

  /** Inside something the site rules say is not read (see the constructor). */
  skipped(el: Element): boolean {
    if (!this.skip) return false;
    const known = this.skipCache.get(el);
    if (known !== undefined) return known;
    let result = false;
    try {
      result = el.closest(this.skip) !== null;
    } catch {
      result = false;
    }
    this.skipCache.set(el, result);
    return result;
  }

  /** Inside an element tagged as a phonetic transcription (see NOTATION). */
  notation(el: Element): boolean {
    const known = this.notationCache.get(el);
    if (known !== undefined) return known;
    const result = NOTATION.test(el.closest('[lang]')?.getAttribute('lang') ?? '');
    this.notationCache.set(el, result);
    return result;
  }

  /** Is this text node drawn on the page at all? */
  rendered(node: Text): boolean {
    const parent = node.parentElement;
    if (!parent) return false;
    if (this.hidden(parent)) return false;
    // Text straight inside a closed <details>, beside its summary.
    if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) return false;
    const style = styleOf(parent);
    return !style || (style.visibility !== 'hidden' && style.visibility !== 'collapse') || revealPending(parent);
  }

  /** Hidden for everything inside it: not rendered, invisible by opacity, or clipped to nothing. */
  hidden(el: Element): boolean {
    const known = this.hiddenCache.get(el);
    if (known !== undefined) return known;
    const result = selfHidden(el, this.fadesIn) || (el.parentElement ? this.hidden(el.parentElement) : false);
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

function selfHidden(el: Element, fadesIn: (el: HTMLElement) => boolean): boolean {
  if (el.hasAttribute('hidden') || el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') return true;
  // The body of a closed <details>: the browser hides it with no style the element itself shows.
  const parent = el.parentElement;
  if (parent?.tagName === 'DETAILS' && !parent.hasAttribute('open') && el.tagName !== 'SUMMARY') return true;
  const style = styleOf(el);
  if (!style) return false;
  // `display: contents` has no box of its own, and hides nothing: its children are drawn.
  if (style.display === 'contents') return false;
  if (style.display === 'none') return true;
  if (Number.parseFloat(style.opacity) === 0 && !awaitingReveal(el, style, fadesIn)) return true;
  // Clipped to nothing: a box with no width or no height that does not let content overflow
  // (a collapsed accordion, a "visually hidden" helper). A zero-height box whose content
  // overflows visibly is not hidden by this — its content is drawn below it.
  const clips = /hidden|clip/.test(style.overflowX) || /hidden|clip/.test(style.overflowY);
  if (clips && el instanceof HTMLElement && (el.offsetWidth <= 1 || el.offsetHeight <= 1)) return true;
  if (/^inset\(\s*(50|100)%/.test(style.clipPath) || /rect\(\s*0(px)?,?\s+0(px)?,?\s+0(px)?,?\s+0(px)?\s*\)/.test(style.clip)) return true;
  return false;
}

/** Libraries that fade text in as it scrolls into view mark it with one of these. */
/**
 * What scroll-reveal libraries leave on the text they will fade in: AOS (`data-aos`, `aos-init`),
 * Sal (`data-sal`), ScrollReveal (`data-sr-id`), WOW.js (`wow`), Animate.css (`animate__`), Webflow
 * interactions (`data-w-id`). Only their own names: a class merely starting with "reveal" can be a
 * spoiler kept hidden on purpose, and `data-reveal` is Foundation's modal.
 */
const REVEAL_MARK = /^(data-aos|data-sal|data-sr-id|data-w-id)$/;
const REVEAL_CLASS = /(^|\s)(aos-(init|animate)|wow|animate__\w+|sal-animate)(\s|$)/;
const REVEAL_SELECTOR = '[data-aos], [data-sal], [data-sr-id], [data-w-id], .wow, .aos-init, .sal-animate';

function marked(el: Element): boolean {
  return [...el.attributes].some((a) => REVEAL_MARK.test(a.name)) || REVEAL_CLASS.test(el.className);
}

/**
 * Transparent, but only until it is scrolled to. Scroll-reveal pages keep every paragraph below the
 * first screen at opacity 0 and fade each in as it arrives — reading only the first screen of such a
 * page was the result of treating them as hidden.
 *
 * Decided by how the element is made, never by where it happens to sit when reading starts (the
 * same paragraph must not be read or skipped depending on the scroll position). A full-size box in
 * the flow of the page, and any of:
 *  - marked by one of those libraries;
 *  - made transparent and moved by a script, on the element itself (GSAP, Framer Motion and
 *    Webflow set an inline opacity and transform to fade text up into place);
 *  - announced to the browser as about to animate (`will-change: opacity | transform`);
 *  - moved out of place (`transform`, or Tailwind v4's own `translate` / `scale`) with a transition
 *    or an animation waiting to bring it back.
 * A collapsed translation has no height; a tooltip or menu floats above the page; a spoiler kept
 * transparent by a class, with nothing set to move it, stays hidden.
 */
function awaitingReveal(el: Element, style: CSSStyleDeclaration, fadesIn: (el: HTMLElement) => boolean): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (!inFlowBox(el, style)) return false;
  // A disclosure first, before any sign of a reveal: a translation a button shows is hidden until
  // it is shown, however it is styled to appear. Checked last, a fade with a movement (or a
  // library's class, or will-change) let it through while its button still said "Reveal".
  if (disclosure(el)) return false;
  if (marked(el)) return true;
  // A script's fade-up: transparent *and* moved, both on the element itself. Inline transparency
  // alone says too little — a modal or an answer can be hidden that way.
  const inlineMoved = el.style.transform !== '' || el.style.getPropertyValue('translate') !== '';
  if (el.style.opacity !== '' && Number.parseFloat(el.style.opacity) === 0 && inlineMoved) return true;
  if (/(^|,\s*)(opacity|transform)(\s*,|$)/.test(style.willChange)) return true;
  const set = (v: string | undefined): boolean => !!v && v !== 'none' && v !== '';
  // A plain fade — transparent, with nothing but a transition on opacity — is the one sign a
  // scroll-reveal paragraph and a disclosure (a translation, an answer that fades in when asked)
  // share, so the element alone cannot tell them apart; nor can where it sits, which would read
  // the same paragraph or skip it depending on the scroll position. Two things on the page can:
  // a control that names it (it is a disclosure), and blocks like it already faded in — a
  // scroll-reveal page fades in what was on screen as it loaded, while a page of translations
  // shows none of them until asked. How many fade proved nothing: three translations fade too.
  if (fadesPlainly(style) && !namedByControl(el) && fadesIn(el)) return true;
  const moved = set(style.transform) || set(style.getPropertyValue('translate')) || set(style.getPropertyValue('scale'));
  return moved && (transitioning(style, /^(all|opacity|transform|translate|scale)$/) || set(style.animationName));
}

/** A full-size box in the flow of the page: not collapsed, not floating above it. */
function inFlowBox(el: HTMLElement, style: CSSStyleDeclaration): boolean {
  if (el.offsetWidth <= 1 || el.offsetHeight <= 1) return false;
  return style.position !== 'absolute' && style.position !== 'fixed';
}

/** A transition on a property matching `re`, longer than `minSeconds`. */
function transitioning(style: CSSStyleDeclaration, re: RegExp, minSeconds = 0): boolean {
  // CSS repeats a shorter list of durations across the properties, cyclically.
  const durations = style.transitionDuration.split(',').map((d) => Number.parseFloat(d) || 0);
  const transitions = style.transitionProperty.split(',').map((p) => p.trim());
  return transitions.some((p, i) => re.test(p) && (durations[i % durations.length] ?? 0) > minSeconds);
}

/** A visible fade on opacity waiting to happen. */
function fadesPlainly(style: CSSStyleDeclaration): boolean {
  return transitioning(style, /^(all|opacity)$/, 0.15);
}

/** Long enough to be a passage of prose rather than a label. */
const PROSE_CHARS = 40;

/**
 * The blocks of prose on this page that fade on opacity and are shown now — faded in, or fading in.
 * Links, buttons and short labels are left out: many sites fade those on hover.
 */
function fadedIn(doc: Document): HTMLElement[] {
  const shown: HTMLElement[] = [];
  for (const el of doc.body?.querySelectorAll('*') ?? []) {
    if (!(el instanceof HTMLElement) || NATIVE_CONTROLS.has(el.tagName) || el.tagName === 'A') continue;
    if ((el.textContent ?? '').trim().length < PROSE_CHARS) continue;
    const style = styleOf(el);
    // Any opacity at all: one still fading in has been revealed as much as one that has finished.
    if (!style || !(Number.parseFloat(style.opacity) > 0) || !fadesPlainly(style) || !inFlowBox(el, style)) continue;
    // A disclosure someone opened is not a page fading its text in: revealing one translation
    // made its still-hidden siblings look like scroll-reveal text, and they were read.
    if (disclosure(el)) continue;
    shown.push(el);
  }
  return shown;
}

/**
 * Is a block like `el` among those already faded in? The same element, and either a class in
 * common or both faded through their own style attribute — the same reveal, not some card
 * elsewhere that fades on hover.
 */
function revealedLike(el: HTMLElement, shown: readonly HTMLElement[]): boolean {
  const classes = [...el.classList];
  const inline = el.style.opacity !== '' || el.style.transition !== '';
  return shown.some(
    (other) =>
      other !== el &&
      other.tagName === el.tagName &&
      (classes.some((c) => other.classList.contains(c)) || (inline && (other.style.opacity !== '' || other.style.transition !== ''))),
  );
}

/**
 * Named by a control on the page — the button or link that reveals it: `aria-controls`, a link to
 * it, Bootstrap's `data-target` / `data-bs-target`, or a click handler that mentions its id.
 */
function namedByControl(el: HTMLElement): boolean {
  for (let at: HTMLElement | null = el; at && at !== at.ownerDocument.body; at = at.parentElement) {
    const id = at.id;
    if (!id) continue;
    const q = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const doc = at.ownerDocument;
    if (doc.querySelector(`[aria-controls~="${q}"], [href="#${q}"], [data-target="#${q}"], [data-bs-target="#${q}"]`)) return true;
    for (const c of doc.querySelectorAll('[onclick]')) {
      const code = c.getAttribute('onclick') ?? '';
      if (code.includes(`#${id}`) || code.includes(`'${id}'`) || code.includes(`"${id}"`)) return true;
    }
  }
  return false;
}

/**
 * Something on the page reveals this block: a control names it (namedByControl), or it comes
 * straight after one — a button, a link or anything clickable — with nothing between, as in
 * `<button onclick="this.nextElementSibling.style.opacity=1">`, which names nothing.
 */
function disclosure(el: HTMLElement): boolean {
  return namedByControl(el) || afterControl(el);
}

/** Straight after a control (or the paragraph holding only one): what such a control usually shows. */
function afterControl(el: HTMLElement): boolean {
  const before = el.previousElementSibling;
  if (!before) return false;
  if (clickable(before)) return true;
  // A paragraph or line whose only content is the control.
  const only = before.children.length === 1 ? before.firstElementChild : null;
  return !!only && clickable(only) && (before.textContent ?? '').trim() === (only.textContent ?? '').trim();
}

function clickable(el: Element): boolean {
  if (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY') return true;
  const role = el.getAttribute('role');
  if (role === 'button' || role === 'tab' || role === 'switch') return true;
  if (CONTROL_ATTRS.some((a) => el.hasAttribute(a))) return true;
  return el.tagName === 'A' && (el.getAttribute('href') ?? '').startsWith('#');
}

/**
 * Hidden with `visibility` by a scroll-reveal library until scrolled to: WOW.js does this, inline, on
 * the element it marks. Such text is waiting, not hidden.
 */
export function revealPending(el: Element): boolean {
  const owner = el.closest(REVEAL_SELECTOR);
  return owner instanceof HTMLElement && owner.style.visibility === 'hidden';
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
