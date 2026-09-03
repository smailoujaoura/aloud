/**
 * Find the element in the *live* DOM that best corresponds to the article body Readability
 * extracted, so the highlight text-index is built over prose only (not the whole page chrome).
 */
import type { ExtractedArticle } from './readability';

const CANDIDATE_SELECTOR =
  'article, main, [role="main"], [itemprop="articleBody"], .post-content, .article-body, .entry-content, .markdown-body, #content, .content, .post, .article';

function visibleTextLength(el: Element): number {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

export function resolveLiveRoot(article: ExtractedArticle, doc: Document = document): Element {
  const target = article.text.replace(/\s+/g, ' ').trim().length;
  if (target === 0) return doc.body;

  let best: Element = doc.body;
  let bestScore = -Infinity;

  const candidates = new Set<Element>([doc.body]);
  doc.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => {
    if (!el.closest('nav, aside, [role="navigation"], [role="complementary"], footer, header')) {
      candidates.add(el);
    }
  });

  for (const el of candidates) {
    const len = visibleTextLength(el);
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
