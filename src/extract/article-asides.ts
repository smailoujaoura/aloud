/**
 * Asides that are part of the article: the note, tip or warning a documentation page puts between
 * its paragraphs.
 *
 * `<aside>` is also what a page's sidebar is, so Aloud passed over every one, and Readability
 * removes them all before it looks at anything else. On The Swift Programming Language every
 * "Note" box was skipped (`<aside class="note">`), even with every "skip" setting off: the passage
 * that says why a type annotation is rarely needed, and a dozen like it. MDN's `.notecard`,
 * Docusaurus's admonitions, GitHub's alerts and Sphinx's `.admonition` are boxes of the same kind,
 * and Readability drops some of those too.
 *
 * One is part of the article when it is inside the article, holds prose rather than links or a
 * form, and either says what it is (a note, a tip, a warning: in its class, role or label) or sits
 * among the article's paragraphs without repeating one of them (a pull quote repeats a sentence of
 * the article, and is left out). A sidebar of related links, a newsletter box or an advert says so
 * in its class, or is mostly links.
 */

/** What a box in the article is called when it is part of it. Matched as whole words. */
const BOX_WORDS =
  /(^|[^a-z])(note|notes|notecard|tip|tips|hint|hints|important|warning|warnings|warn|caution|danger|attention|info|callout|callouts|admonition|admonitions|alert|remark|example|deprecated|experimental|todo|seealso|definition|sidenote|side-note|key-?point|takeaway)([^a-z]|$)/;

/**
 * What it is called when it is not: promotion, navigation, discussion, the author's box. Also used
 * for whatever surrounds a passage Readability dropped from the middle of an article (block-model.ts).
 */
export const NOT_CONTENT =
  /(^|[^a-z])(related|promo|promos|promotion|promoted|newsletter|newsletters|subscribe|subscription|signup|sign-up|share|sharing|social|sponsor|sponsored|advert|adverts|advertisement|advertising|ad|ads|adslot|ad-slot|dfp|outbrain|taboola|recommend|recommended|recommendations|recirc|teaser|teasers|widget|widgets|cta|banner|popup|modal|cookie|cookies|consent|paywall|comment|comments|disqus|nav|navigation|menu|toc|breadcrumb|breadcrumbs|author|authors|bio|byline|tags|newsroom|more-stories|most-popular|trending)([^a-z]|$)/;

const PULL_QUOTE = /pull[\s_-]?quote|blockquote-pull|pullout/;

/** The words an element is named by: its class, id, role, label and kind. */
export function namesOf(el: Element): string {
  const attr = (name: string): string => el.getAttribute(name) ?? '';
  const cls = typeof el.className === 'string' ? el.className : attr('class');
  return `${cls} ${el.id} ${attr('role')} ${attr('aria-label')} ${attr('data-type')} ${attr('data-callout')}`.toLowerCase();
}

/** Tags that are the article's own prose, when an aside stands beside them. */
const PROSE_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'UL', 'OL', 'DL', 'BLOCKQUOTE', 'TABLE', 'FIGURE']);

/**
 * Is `el` (an `<aside>`, a `role="note"` or `role="complementary"` box, or one named like a note)
 * part of the article inside `root`? Without `root` (Readability's copy of the page, where the
 * article is not found yet), only what the element itself and its neighbours say.
 */
export function articleAside(el: Element, root?: Element | null): boolean {
  if (root && (el === root || !root.contains(el))) return false;
  const words = namesOf(el);
  if (NOT_CONTENT.test(words) || PULL_QUOTE.test(words)) return false;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 20 || !/\p{L}{3}/u.test(text)) return false;
  if (linkShare(el, text.length) > 0.5) return false;
  if (el.querySelector('form, input, select, textarea, iframe')) return false;
  if (el.getAttribute('role') === 'note' || BOX_WORDS.test(words)) return true;
  // Unnamed: an <aside> (or a complementary box) among the article's paragraphs, not repeating one.
  const tag = el.tagName;
  if (tag !== 'ASIDE' && el.getAttribute('role') !== 'complementary') return false;
  return amongProse(el) && !repeatsArticle(el, text, root ?? el.parentElement);
}

/** The nearest element from `el` up to `root` that is such an aside, or null. */
export function asideAround(el: Element, root: Element, cache?: Map<Element, Element | null>): Element | null {
  const seen: Element[] = [];
  let found: Element | null = null;
  for (let at: Element | null = el; at && at !== root; at = at.parentElement) {
    const known = cache?.get(at);
    if (known !== undefined) {
      found = known;
      break;
    }
    seen.push(at);
    if (looksLikeBox(at) && articleAside(at, root)) {
      found = at;
      break;
    }
  }
  if (cache) for (const s of seen) cache.set(s, found);
  return found;
}

/** Worth asking `articleAside` about: an aside, a note or complementary box, or one named like a note. */
export function looksLikeBox(el: Element): boolean {
  if (el.tagName === 'ASIDE') return true;
  const role = el.getAttribute('role');
  if (role === 'note' || role === 'complementary') return true;
  const tag = el.tagName;
  if (tag !== 'DIV' && tag !== 'SECTION' && tag !== 'BLOCKQUOTE' && tag !== 'DETAILS') return false;
  return BOX_WORDS.test(namesOf(el));
}

function linkShare(el: Element, total: number): number {
  let links = 0;
  for (const a of el.querySelectorAll('a')) links += (a.textContent ?? '').replace(/\s+/g, ' ').trim().length;
  return links / Math.max(1, total);
}

/** Beside the article's own prose: a paragraph, heading or code listing next to it, or under the same parent. */
function amongProse(el: Element): boolean {
  const beside = [el.previousElementSibling, el.nextElementSibling];
  for (const sib of beside) {
    if (!sib) continue;
    if (PROSE_TAGS.has(sib.tagName) || sib.querySelector(':scope > pre, :scope > p')) return true;
  }
  const parent = el.parentElement;
  return !!parent && parent.querySelectorAll(':scope > p').length >= 2;
}

/** Does its text appear a second time in the article (a pull quote)? */
function repeatsArticle(el: Element, text: string, scope: Element | null): boolean {
  if (!scope) return false;
  const sample = text.slice(0, 60);
  if (sample.length < 20) return false;
  const all = (scope.textContent ?? '').replace(/\s+/g, ' ');
  const first = all.indexOf(sample);
  return first >= 0 && all.indexOf(sample, first + 1) >= 0;
}
