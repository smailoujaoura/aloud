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

/** `text` with numbers in words and Latin letters in Cyrillic, ready for a Ukrainian letter voice. */
export function ukrainianForTextVoice(text: string): string {
  return (
    text
      // A decimal: Ukrainian writes "3,5" and says "три кома п'ять". "3.5" reads the same.
      .replace(/(\d+)[.,](\d+)/g, (_, whole: string, frac: string) => `${ukrainianNumber(whole)} кома ${ukrainianNumber(frac)}`)
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
