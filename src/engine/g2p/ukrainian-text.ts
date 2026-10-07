/**
 * Ukrainian text for a Piper voice that reads letters, not phonemes (`phoneme_type: "text"`).
 *
 * Such a voice knows only the symbols it was trained on: for the Ukrainian ones, the Cyrillic
 * alphabet, an apostrophe and some punctuation. Anything else has no sound and was dropped — "У
 * 2024 році Python" was read "у році". So numbers are written out as Ukrainian words, and Latin
 * letters as the Cyrillic ones a Ukrainian reader would say for them.
 *
 * Numbers come out in the nominative ("дві тисячі двадцять чотири"): the right case depends on
 * the sentence ("у дві тисячі двадцять четвертому році"), which takes a grammar to know. A
 * number in the wrong case is understood; a number not said at all is not.
 */

const ONES_M = ['нуль', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const ONES_F = ['нуль', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const TEENS = [
  'десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять',
  "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять",
];
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];

/** [one, two-to-four, five-and-up], and whether the scale word is feminine. */
const SCALES: Array<{ forms: [string, string, string]; feminine: boolean }> = [
  { forms: ['', '', ''], feminine: false },
  { forms: ['тисяча', 'тисячі', 'тисяч'], feminine: true },
  { forms: ['мільйон', 'мільйони', 'мільйонів'], feminine: false },
  { forms: ['мільярд', 'мільярди', 'мільярдів'], feminine: false },
];

function plural(n: number, [one, few, many]: [string, string, string]): string {
  const last2 = n % 100;
  const last = n % 10;
  if (last2 >= 11 && last2 <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** 1–999, in words. */
function triple(n: number, feminine: boolean): string[] {
  const words: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) words.push(HUNDREDS[h]!);
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]!);
  else {
    if (rest >= 20) words.push(TENS[Math.floor(rest / 10)]!);
    if (rest % 10) words.push((feminine ? ONES_F : ONES_M)[rest % 10]!);
  }
  return words;
}

/** A whole number in Ukrainian words; digit by digit past the billions. */
export function ukrainianNumber(digits: string): string {
  const clean = digits.replace(/^0+(?=\d)/, '');
  if (clean.length > 12) return [...digits].map((d) => ONES_M[Number(d)]!).join(' ');
  let n = Number(clean);
  if (n === 0) return ONES_M[0]!;
  const parts: string[] = [];
  for (let scale = 0; n > 0; scale++, n = Math.floor(n / 1000)) {
    const group = n % 1000;
    if (group === 0) continue;
    const { forms, feminine } = SCALES[scale]!;
    // "тисяча", not "одна тисяча": as it is said.
    const words = scale === 1 && group === 1 ? [] : triple(group, feminine);
    if (scale > 0) words.push(plural(group, forms));
    parts.unshift(words.join(' '));
  }
  return parts.join(' ');
}

/** Latin spelled as a Ukrainian reader says it: digraphs first, then letters. */
const LATIN_PAIRS: Array<[RegExp, string]> = [
  [/sch/g, 'ш'], [/sh/g, 'ш'], [/ch/g, 'ч'], [/th/g, 'т'], [/ph/g, 'ф'], [/zh/g, 'ж'], [/kh/g, 'х'],
  [/ts/g, 'ц'], [/oo/g, 'у'], [/ee/g, 'і'], [/qu/g, 'кв'], [/ck/g, 'к'],
  [/c(?=[eiy])/g, 'ц'],
];
const LATIN: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'ґ', h: 'х', i: 'і', j: 'дж', k: 'к', l: 'л', m: 'м',
  n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'і', z: 'з',
};

function latinWord(word: string): string {
  let out = word.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  for (const [from, to] of LATIN_PAIRS) out = out.replace(from, to);
  return out.replace(/[a-z]/g, (c) => LATIN[c] ?? '');
}

/**
 * The part after the decimal comma. Not a whole number: `ukrainianNumber` drops leading zeros,
 * which is right for 007 and wrong here — it made 0,5, 0,05 and 0,005 the same spoken dose. The
 * zeros are said one by one, as a reader does: "нуль кома нуль нуль п'ять".
 */
function fraction(digits: string): string {
  const zeros = /^0+/.exec(digits)?.[0].length ?? 0;
  const rest = digits.slice(zeros);
  const said = Array.from({ length: zeros }, () => ONES_M[0]!);
  if (rest !== '') said.push(ukrainianNumber(rest));
  return said.join(' ');
}

// ---- dates ------------------------------------------------------------------

/** The day as Ukrainians say it in a date: "п'яте", "двадцять перше" (neuter, nominative). */
const DAY_ORD = [
  '', 'перше', 'друге', 'третє', 'четверте', "п'яте", 'шосте', 'сьоме', 'восьме', "дев'яте",
  'десяте', 'одинадцяте', 'дванадцяте', 'тринадцяте', 'чотирнадцяте', "п'ятнадцяте",
  'шістнадцяте', 'сімнадцяте', 'вісімнадцяте', "дев'ятнадцяте", 'двадцяте',
];
const MONTH_GEN = [
  '', 'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];
/** Ordinals in the genitive — "of the year two thousand and twenty-*sixth*". */
const UNIT_ORD_GEN = ['', 'першого', 'другого', 'третього', 'четвертого', "п'ятого", 'шостого', 'сьомого', 'восьмого', "дев'ятого"];
const TEEN_ORD_GEN = [
  'десятого', 'одинадцятого', 'дванадцятого', 'тринадцятого', 'чотирнадцятого',
  "п'ятнадцятого", 'шістнадцятого', 'сімнадцятого', 'вісімнадцятого', "дев'ятнадцятого",
];
const TEN_ORD_GEN = ['', '', 'двадцятого', 'тридцятого', 'сорокового', "п'ятдесятого", 'шістдесятого', 'сімдесятого', 'вісімдесятого', "дев'яностого"];
const HUNDRED_ORD_GEN = ['', 'сотого', 'двохсотого', 'трьохсотого', 'чотирьохсотого', "п'ятисотого", 'шестисотого', 'семисотого', 'восьмисотого', "дев'ятисотого"];
const THOUSAND_PREFIX = ['', '', 'двох', 'трьох', 'чотирьох', "п'яти", 'шести', 'семи', 'восьми', "дев'яти"];

function dayOrdinal(day: number): string {
  if (day <= 20) return DAY_ORD[day]!;
  if (day % 10 === 0) return day === 30 ? 'тридцяте' : DAY_ORD[day]!;
  return `${TENS[Math.floor(day / 10)]} ${DAY_ORD[day % 10]}`;
}

/** 1–999 as a genitive ordinal: only the last word takes the ordinal form, as in speech. */
function ordinalGenitive(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (r === 0) return HUNDRED_ORD_GEN[h]!;
  const words: string[] = h ? [HUNDREDS[h]!] : [];
  if (r < 10) words.push(UNIT_ORD_GEN[r]!);
  else if (r < 20) words.push(TEEN_ORD_GEN[r - 10]!);
  else if (r % 10 === 0) words.push(TEN_ORD_GEN[r / 10]!);
  else words.push(TENS[Math.floor(r / 10)]!, UNIT_ORD_GEN[r % 10]!);
  return words.join(' ');
}

/** A year as it is said in a date: "дві тисячі двадцять шостого року". */
function yearGenitive(year: number): string {
  const th = Math.floor(year / 1000);
  const rest = year % 1000;
  if (rest === 0) return th === 1 ? 'тисячного' : `${THOUSAND_PREFIX[th]}тисячного`;
  const lead = th ? `${ukrainianNumber(String(th * 1000))} ` : '';
  return `${lead}${ordinalGenitive(rest)}`;
}

/**
 * "05.10.2026" as a date — "п'яте жовтня дві тисячі двадцять шостого року". Read as numbers it
 * was "п'ять кома десять…", the dots taken for decimal points.
 */
function ukrainianDate(d: string, m: string, y: string): string | null {
  const day = Number(d);
  const month = Number(m);
  const year = Number(y);
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1000 || year > 9999) return null;
  return `${dayOrdinal(day)} ${MONTH_GEN[month]} ${yearGenitive(year)} року`;
}

/** `text` with numbers in words and Latin letters in Cyrillic, ready for a Ukrainian letter voice. */
export function ukrainianForTextVoice(text: string): string {
  return (
    text
      // A sign before a number is a word, not a symbol: the voice has no glyph for "−" or "-",
      // so they were dropped and −0,05 was spoken as 0,05 — the same dose, the other way round.
      .replace(/(^|[\s(\[:;,])[-−–—](?=\d)/g, '$1мінус ')
      .replace(/(^|[\s(\[:;,])\+(?=\d)/g, '$1плюс ')
      // Dates first: their dots are not decimal points.
      .replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (all: string, d: string, m: string, y: string) => ukrainianDate(d, m, y) ?? all)
      // Thousands grouped the Ukrainian way, with a space ("1 000", often a no-break space), or
      // the English way in more than one group ("1,000,000" can be nothing else). A single group
      // after a comma is a decimal in Ukrainian ("3,500" is three and a half) — except ",000",
      // which no one writes as a decimal: "1,000" read "один кома нуль нуль нуль".
      // Not from a leading zero: "067 123 45 67" is a phone number, not sixty-seven thousand.
      .replace(/\b(?!0)\d{1,3}(?:[ \u00A0\u202F]\d{3})+\b/g, (n: string) => n.replace(/\D/g, ''))
      .replace(/\b\d{1,3}(?:([,.])\d{3})(?:\1\d{3})+\b/g, (n: string) => n.replace(/\D/g, ''))
      .replace(/\b(\d{1,3}),000\b(?![,.]\d)/g, '$1000')
      // A decimal: Ukrainian writes "3,5" and says "три кома п'ять". "3.5" reads the same.
      .replace(/(\d+)[.,](\d+)/g, (_, whole: string, frac: string) => `${ukrainianNumber(whole)} кома ${fraction(frac)}`)
      .replace(/\d+/g, (d) => ` ${ukrainianNumber(d)} `)
      .replace(/%/g, ' відсотків')
      .replace(/&/g, ' і ')
      .replace(/\+/g, ' плюс ')
      .replace(/[A-Za-zÀ-ɏ]+/g, latinWord)
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ ([,.;:!?])/g, '$1')
      .trim()
  );
}
