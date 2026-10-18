/**
 * What not to read on a page, as data: CSS selectors and patterns per platform and per site
 * (site-rules.json), applied in one place.
 *
 * The rules are data only — no code — so the list can change on its own schedule, like an ad
 * blocker's filter lists. Today it ships inside Aloud; the format does not depend on that.
 *
 * - `skip`: selectors whose text is never said. A paragraph's citation marker ("[12]") is blanked
 *   inside the sentence, an infobox or a share bar drops out whole — the text index marks their
 *   text as not spoken (text-index.ts), the same way hidden text is. Grouped by the reader's skip
 *   settings (`references`, `captions`, `tables`, `code`); `always` ignores them.
 * - `skipSectionsAfterHeading`: an end-of-article heading ("Weblinks", "Note") and everything under
 *   it, to the next heading of the same level.
 * - `skipShortText`: a whole short block that is apparatus ("Was this page helpful?").
 * - `root`: where the article is, when the page says so plainly.
 */
import data from './site-rules.json';
import type { SkipSettings } from '@/shared/settings';

type Category = 'always' | keyof SkipSettings;

interface RawRule {
  id: string;
  match: { any?: boolean; host?: string[]; generator?: string; selector?: string };
  root?: string[];
  skip?: Partial<Record<Category, string[]>>;
  skipSectionsAfterHeading?: Array<{ pattern: string; as: Category }>;
  skipShortText?: Array<{ pattern: string; maxChars: number }>;
}

export interface PageRules {
  /** Ids of the rules that apply, for logs and bug reports. */
  ids: string[];
  roots: string[];
  skip: Record<Category, string[]>;
  sections: Array<{ re: RegExp; as: Category }>;
  shortText: Array<{ re: RegExp; maxChars: number }>;
}

const RULES = (data as { rules: RawRule[] }).rules;

/** `*.medium.com` matches `x.medium.com` and `medium.com`; anything else must be equal. */
function hostMatches(host: string, glob: string): boolean {
  if (glob.startsWith('*.')) return host === glob.slice(2) || host.endsWith(glob.slice(1));
  return host === glob;
}

function validSelector(doc: Document, selector: string): boolean {
  try {
    doc.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

function regex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    return null;
  }
}

/** The rules for this page: generic ones, then every platform and site rule that matches. */
export function rulesFor(doc: Document, url: string = doc.location?.href ?? ''): PageRules {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* no address: generic rules only */
  }
  const generator = doc.querySelector('meta[name="generator" i]')?.getAttribute('content') ?? '';
  const out: PageRules = {
    ids: [],
    roots: [],
    skip: { always: [], references: [], captions: [], tables: [], code: [] },
    sections: [],
    shortText: [],
  };
  for (const rule of RULES) {
    const m = rule.match;
    if (!m.any) {
      if (m.host && !m.host.some((glob) => hostMatches(host, glob))) continue;
      if (m.generator && !regex(m.generator)?.test(generator)) continue;
      if (m.selector && !(validSelector(doc, m.selector) && doc.querySelector(m.selector))) continue;
      if (!m.host && !m.generator && !m.selector) continue;
    }
    out.ids.push(rule.id);
    for (const r of rule.root ?? []) if (validSelector(doc, r)) out.roots.push(r);
    for (const [category, selectors] of Object.entries(rule.skip ?? {}) as Array<[Category, string[]]>) {
      for (const s of selectors) if (validSelector(doc, s) && !out.skip[category].includes(s)) out.skip[category].push(s);
    }
    for (const s of rule.skipSectionsAfterHeading ?? []) {
      const re = regex(s.pattern);
      if (re) out.sections.push({ re, as: s.as });
    }
    for (const s of rule.skipShortText ?? []) {
      const re = regex(s.pattern);
      if (re) out.shortText.push({ re, maxChars: s.maxChars });
    }
  }
  return out;
}

/** One selector for everything not to be said, given the reader's skip settings ('' for none). */
export function skipSelector(rules: PageRules, skip: SkipSettings): string {
  const parts = [...rules.skip.always];
  for (const category of ['references', 'captions', 'tables', 'code'] as const) if (skip[category]) parts.push(...rules.skip[category]);
  return parts.join(', ');
}

/** Is this heading the start of an end section the settings skip ("Weblinks", "Note")? */
export function endSectionHeading(rules: PageRules, skip: SkipSettings, text: string): boolean {
  return rules.sections.some(({ re, as }) => (as === 'always' || skip[as as keyof SkipSettings]) && re.test(text));
}

/** A whole block that is apparatus by its words alone ("Was this page helpful?"). */
export function apparatusText(rules: PageRules, text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return rules.shortText.some(({ re, maxChars }) => t.length <= maxChars && re.test(t));
}

/** The first root a rule names that holds a real article (200 characters or more). */
export function ruleRoot(rules: PageRules, doc: Document): Element | null {
  for (const selector of rules.roots) {
    const el = doc.querySelector(selector);
    if (el && (el.textContent ?? '').replace(/\s+/g, ' ').trim().length >= 200) return el;
  }
  return null;
}
