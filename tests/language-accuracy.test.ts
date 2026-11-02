import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planLanguages, type Detector } from '@/content/language-plan';

/**
 * How often the reader names the right language, measured on labelled lines in 15 languages
 * (fixtures/language-samples.json) with the answers Chromium's detector really gave for them
 * (fixtures/language-detector-chromium.json) and Firefox's (-firefox.json). Each line is judged alone, and inside an English
 * article: a French line quoted in an English page, a site's button in another language.
 *
 * Measured 2 November 2026, before and after short lines were trusted in the languages the
 * detector gets right short (language-plan.ts: trustedShort), alone / inside an English page:
 *   Chromium 151: short 20 → 36 of 45, medium 21-23 → 39-40 of 45, sentences 30 of 30.
 *   Firefox 153:  short 26 → 33 of 45, medium 34 → 34 of 45, sentences 30 of 30. (Its detector
 *   gives no answer at all for 27 of the short lines.)
 * The floors below are those results, so a change that makes either worse fails here.
 */
const samples = JSON.parse(readFileSync('tests/fixtures/language-samples.json', 'utf8')) as Record<string, Record<string, string[]>>;
type Answers = Record<string, { reliable: boolean; languages: Array<[string, number]> }>;
const recorded = (browser: string): Answers => (JSON.parse(readFileSync(`tests/fixtures/language-detector-${browser}.json`, 'utf8')) as { answers: Answers }).answers;
const lines = Object.entries(samples)
  .filter(([lang]) => !lang.startsWith('$'))
  .flatMap(([lang, buckets]) => Object.entries(buckets).flatMap(([bucket, texts]) => texts.map((text) => ({ lang, bucket, text }))));

const before = 'This is an ordinary English paragraph about lighthouses and the people who kept them.';
const after = 'The next paragraph carries on in English, as the article does.';

async function score(bucket: string, judge: (text: string) => Promise<string | undefined>): Promise<number> {
  const some = lines.filter((l) => l.bucket === bucket);
  let right = 0;
  for (const l of some) if ((await judge(l.text)) === l.lang) right++;
  return right / some.length;
}

const FLOORS = { chromium: { medium: 0.85, short: 0.78 }, firefox: { medium: 0.75, short: 0.73 } } as const;

for (const browser of ['chromium', 'firefox'] as const) describe(`naming the language of a line, with ${browser}'s detector (#2)`, () => {
  const answers = recorded(browser);
  const detect: Detector = async (text) => {
    const a = answers[text];
    return a?.languages[0] ? { language: a.languages[0][0], reliable: a.reliable } : null;
  };
  const alone = async (text: string) => (await planLanguages([{ text, markup: '' }], detect, '', new Map(), ''))[0]?.language;
  const inEnglish = async (text: string) => (await planLanguages([before, text, after].map((t) => ({ text: t, markup: '' })), detect, 'en', new Map(), 'en'))[1]?.language;

  it('has a detector answer recorded for every labelled line', () => {
    expect(lines).toHaveLength(120);
    for (const l of lines) expect(answers[l.text], l.text).toBeDefined();
  });

  it('a full sentence: always right', async () => {
    expect(await score('long', alone)).toBe(1);
    expect(await score('long', inEnglish)).toBe(1);
  });

  it('a few words (4 to 8): as often right as measured, alone or inside an English page', async () => {
    expect(await score('medium', alone)).toBeGreaterThanOrEqual(FLOORS[browser].medium);
    expect(await score('medium', inEnglish)).toBeGreaterThanOrEqual(FLOORS[browser].medium);
  });

  it('a button or a short line (1 to 3 words): as often right as measured', async () => {
    expect(await score('short', alone)).toBeGreaterThanOrEqual(FLOORS[browser].short);
    expect(await score('short', inEnglish)).toBeGreaterThanOrEqual(FLOORS[browser].short);
  });

  it('never moves an English line of an English page to another language', async () => {
    for (const l of lines.filter((x) => x.lang === 'en')) expect(await inEnglish(l.text), l.text).toBe('en');
  });
});
