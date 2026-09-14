/**
 * Your own pronunciation fixes: "say *this* when you see *that*".
 *
 * Every speech engine gets something wrong that matters to one reader — an acronym read as a
 * word ("GPU" as "gupoo"), a surname, a product name, a term of art. A short list of replacements,
 * applied to the text before it reaches the engine, fixes all of those without touching what is
 * highlighted: the rules change the *spoken* text only.
 *
 * Matching is whole-word and, unless a rule says otherwise, case-insensitive, so "GPU" also fixes
 * "gpu". Longer rules win over shorter ones that overlap them ("New York Times" before "New
 * York"). Whitespace inside a rule matches any run of whitespace, because a phrase is often broken
 * across a line in the source.
 */

export interface PronunciationRule {
  /** As written on the page. */
  from: string;
  /** How it should be said. */
  to: string;
  /** Match capitalisation exactly — for words that are only special in one case ("US" vs "us"). */
  matchCase?: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const squash = (text: string): string => text.trim().replace(/\s+/g, ' ');

/**
 * A pattern for one rule. Word boundaries are only demanded on a side that *is* a word character,
 * so "C++" and "#hashtag" still match where `\b` would refuse them.
 */
function patternFor(from: string): string {
  const body = escapeRegExp(from).replace(/\s+/g, '\\s+');
  const start = WORD_CHAR.test(from[0] ?? '') ? '(?<![\\p{L}\\p{N}_])' : '';
  const end = WORD_CHAR.test(from.at(-1) ?? '') ? '(?![\\p{L}\\p{N}_])' : '';
  return `${start}${body}${end}`;
}

function replaceWith(text: string, rules: PronunciationRule[], matchCase: boolean): string {
  if (rules.length === 0) return text;
  const lookup = new Map<string, string>();
  for (const rule of rules) {
    const key = matchCase ? squash(rule.from) : squash(rule.from).toLowerCase();
    // First rule wins on a duplicate, so the list reads top-to-bottom like a person would expect.
    if (!lookup.has(key)) lookup.set(key, rule.to);
  }
  const ordered = [...lookup.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(ordered.map(patternFor).join('|'), matchCase ? 'gu' : 'giu');
  return text.replace(pattern, (match) => {
    const key = matchCase ? squash(match) : squash(match).toLowerCase();
    return lookup.get(key) ?? match;
  });
}

/** Apply every usable rule to `text`. Case-sensitive rules run first, so they take precedence. */
export function applyPronunciations(text: string, rules: readonly PronunciationRule[] | undefined): string {
  // A rule with nothing to say is almost always one still being typed; applying it would delete
  // the word from speech mid-edit, so it waits until it has a reading.
  const usable = (rules ?? []).filter((r) => squash(r.from).length > 0 && r.to.trim().length > 0);
  if (usable.length === 0) return text;
  const exact = usable.filter((r) => r.matchCase);
  const loose = usable.filter((r) => !r.matchCase);
  return replaceWith(replaceWith(text, exact, true), loose, false);
}
