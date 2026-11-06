/**
 * The page as it is drawn, through web components.
 *
 * MSN writes its articles inside web components (open shadow roots, up to four deep): 4,873 to
 * 8,453 characters of an article there, 1,100 in the page itself (its footer). Readability works on
 * `document.cloneNode()`, which copies no shadow root, and a TreeWalker stops at every one, so
 * Aloud found no article. Here: the "flat tree" (what is rendered, in order: a component's shadow
 * content in place of its children, a <slot> replaced by what is slotted into it), a copy of the
 * page made from it for Readability, and parents that cross into and out of components.
 *
 * Pages without a shadow root are untouched: every caller checks `hasShadowRoots` first.
 */

/** The attribute that ties a copied element to the live one (flatCopy, articleRootFrom). */
export const FLAT_MARK = 'data-aloud-flat';

/** Does the page (or `root`) hold any open shadow root at all? */
export function hasShadowRoots(root: Document | Element): boolean {
  const scope = root.nodeType === Node.DOCUMENT_NODE ? (root as Document).documentElement : (root as Element);
  if (!scope) return false;
  if ((scope as Element).shadowRoot) return true;
  const walker = scope.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Element).shadowRoot) return true;
  return false;
}

/** What `node` shows, in order: a component's shadow content, a slot's slotted nodes. */
export function flatChildren(node: Node): Node[] {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === 'SLOT' && (el.getRootNode() as ShadowRoot).host) {
      const assigned = (el as HTMLSlotElement).assignedNodes();
      return assigned.length ? assigned : [...el.childNodes];
    }
  }
  return [...node.childNodes];
}

/**
 * The element `node` is drawn in: its parent, the slot it is slotted into, or the component that
 * holds a shadow root. Slots themselves are passed over (they draw no box of their own, so a check
 * on their size would find every slotted paragraph hidden).
 */
export function renderedParent(node: Node): Element | null {
  let at: Node | null = node;
  for (;;) {
    let up: Element | null = slotOf(at) ?? at.parentElement;
    if (!up) {
      const parent: ParentNode | null = at.parentNode;
      up = parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? ((parent as ShadowRoot).host ?? null) : null;
    }
    if (!up || up.tagName !== 'SLOT') return up;
    at = up;
  }
}

/** The slot `node` is drawn in, when its parent is a component. */
function slotOf(node: Node): HTMLSlotElement | null {
  const assigned = (node as Element | Text).assignedSlot;
  if (assigned !== undefined) return assigned;
  // No `assignedSlot` (a test DOM): the slot named by the node's `slot`, or the default one.
  const shadow = node.parentElement?.shadowRoot;
  if (!shadow) return null;
  const name = node.nodeType === Node.ELEMENT_NODE ? (node as Element).getAttribute('slot') ?? '' : '';
  return (name ? shadow.querySelector(`slot[name="${CSS.escape(name)}"]`) : shadow.querySelector('slot:not([name])')) as HTMLSlotElement | null;
}

/** Text nodes (and <br>s, when asked) under `root`, in the order they are drawn. */
export function* flatNodes(root: Node, withBreaks = false): Generator<Node> {
  const stack: Node[] = [...flatChildren(root)].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === Node.TEXT_NODE) {
      yield node;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = (node as Element).tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT') continue;
    if (withBreaks && tag === 'BR') yield node;
    const children = flatChildren(node);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}

/** The text `el` shows, through its components. */
export function flatText(el: Element): string {
  let out = '';
  for (const n of flatNodes(el)) out += n.nodeValue ?? '';
  return out;
}

/** Every element under `root` matching `selector`, inside components too. */
export function deepQueryAll(root: Document | ShadowRoot | Element, selector: string): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  const hosts = root.querySelectorAll('*');
  for (const el of hosts) if (el.shadowRoot) out.push(...deepQueryAll(el.shadowRoot, selector));
  return out;
}

/** The shadow roots holding the given nodes, once each. */
export function shadowRootsOf(nodes: Iterable<Node>): ShadowRoot[] {
  const roots = new Set<ShadowRoot>();
  for (const n of nodes) {
    const root = n.getRootNode();
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (root as ShadowRoot).host) roots.add(root as ShadowRoot);
  }
  return [...roots];
}

/**
 * A copy of `doc` with its components' contents in place, for Readability: what a reader of the
 * page sees, as one ordinary document. Styles and scripts are left out; the head is copied as is.
 */
export function flatCopy(doc: Document, live?: Map<string, Element>): Document {
  const copy = doc.implementation.createHTMLDocument(doc.title);
  let n = 0;
  const lang = doc.documentElement.getAttribute('lang');
  if (lang) copy.documentElement.setAttribute('lang', lang);
  for (const node of doc.head?.childNodes ?? []) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'SCRIPT') continue;
    copy.head.append(copy.importNode(node, true));
  }
  const build = (from: Node, into: Node): void => {
    for (const child of flatChildren(from)) {
      if (child.nodeType === Node.TEXT_NODE) {
        into.appendChild(copy.createTextNode(child.nodeValue ?? ''));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE' || tag === 'NOSCRIPT' || tag === 'LINK') continue;
        // A slot is drawn as what is in it: its contents, not the element.
        if (tag === 'SLOT') {
          build(el, into);
          continue;
        }
        let made: Element;
        try {
          made = copy.createElement(el.localName);
        } catch {
          made = copy.createElement('div');
        }
        for (const attr of el.attributes) {
          if (attr.name === 'slot' || attr.name.startsWith('on')) continue;
          try {
            made.setAttribute(attr.name, attr.value);
          } catch {
            /* a name the copy will not take */
          }
        }
        // Which live element it copies (`live`): Readability keeps the mark, so the paragraphs it
        // chose can be found on the page again (articleRootFrom).
        if (live) {
          const id = String(++n);
          made.setAttribute(FLAT_MARK, id);
          live.set(id, el);
        }
        into.appendChild(made);
        build(el, made);
      }
    }
  };
  if (doc.body) build(doc.body, copy.body);
  return copy;
}

/**
 * Where on the live page the article Readability found in a flat copy is: the innermost element,
 * through components, holding most of the text it kept. Most, not all: on MSN it also kept a
 * line or two of promotion beside the article ("Upgrade your Chrome browser…"), and an element
 * holding those too was nearly the whole page (268 sentences, the banner first). Null when it
 * kept too little to tell.
 */
export function articleRootFrom(html: string, live: Map<string, Element>, doc: Document): { root: Element; blocks: Element[] } | null {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const found: Element[] = [];
  for (const el of parsed.body.querySelectorAll(`p[${FLAT_MARK}], h1[${FLAT_MARK}], h2[${FLAT_MARK}], h3[${FLAT_MARK}], li[${FLAT_MARK}], blockquote[${FLAT_MARK}]`)) {
    const original = live.get(el.getAttribute(FLAT_MARK) ?? '');
    if (original && original.ownerDocument === doc) found.push(original);
  }
  if (found.length < 2) return null;
  const root = mostlyHolding(found, 0.85);
  return root ? { root, blocks: found } : null;
}

/** The innermost element, through components, holding `share` of the text of `els` (by length). */
export function mostlyHolding(els: readonly Element[], share: number): Element | null {
  const held = new Map<Element, number>();
  const depth = new Map<Element, number>();
  let total = 0;
  for (const el of els) {
    const len = Math.max(1, flatText(el).trim().length);
    total += len;
    const chain: Element[] = [];
    for (let at: Element | null = el; at; at = renderedParent(at)) chain.push(at);
    chain.forEach((at, i) => {
      held.set(at, (held.get(at) ?? 0) + len);
      depth.set(at, chain.length - i);
    });
  }
  let best: Element | null = null;
  for (const [el, len] of held) {
    if (len < total * share) continue;
    if (!best || (depth.get(el) ?? 0) > (depth.get(best) ?? 0)) best = el;
  }
  return best;
}
