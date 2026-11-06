/**
 * Find the element in the *live* DOM that best corresponds to the article body Readability
 * extracted, so the highlight text-index is built over prose only (not the whole page chrome).
 */
import type { ExtractedArticle } from './readability';
import { deepQueryAll, flatText } from './flat-tree';

const CANDIDATE_SELECTOR =
  'article, main, [role="main"], [itemprop="articleBody"], .post-content, .article-body, .entry-content, .markdown-body, #content, .content, .post, .article';

function visibleTextLength(el: Element): number {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

export function resolveLiveRoot(article: ExtractedArticle, doc: Document = document): Element {
  // Found in a flat copy through web components, and traced back to the page (flat-tree.ts).
  if (article.liveRoot?.isConnected) return article.liveRoot;
  const target = article.text.replace(/\s+/g, ' ').trim().length;
  if (target === 0) return doc.body;

  let best: Element = doc.body;
  let bestScore = -Infinity;

  const candidates = new Set<Element>([doc.body]);
  // An article found inside web components (flat-tree.ts): its container is in one, and only what
  // the components show measures it. A component itself can be the container.
  const flat = article.flat === true;
  const found = flat ? deepQueryAll(doc, CANDIDATE_SELECTOR) : [...doc.querySelectorAll(CANDIDATE_SELECTOR)];
  if (flat) for (const el of deepQueryAll(doc, '*')) if (el.shadowRoot) found.push(el);
  for (const el of found) {
    if (!el.closest('nav, aside, [role="navigation"], [role="complementary"], footer, header')) {
      candidates.add(el);
    }
  }

  for (const el of candidates) {
    const len = flat ? flatText(el).replace(/\s+/g, ' ').trim().length : visibleTextLength(el);
    if (len < Math.min(200, target * 0.3)) continue;
    // Prefer the tightest element that still covers most of the article text.
    const coverage = Math.min(len, target) / target;
    const tightness = target / Math.max(len, target);
    const score = coverage * 2 + tightness - (el === doc.body ? 0.3 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}
