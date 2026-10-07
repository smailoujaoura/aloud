/** The second review: a Ukrainian "text" voice dropped every digit and Latin letter ("У 2024 році" → "у році"). */
import { describe, expect, it } from 'vitest';
import { ukrainianForTextVoice, ukrainianNumber } from '@/engine/g2p/ukrainian-text';

describe('Ukrainian for a letter voice', () => {
  it('numbers, in words', () => {
    expect(ukrainianNumber('0')).toBe('нуль');
    expect(ukrainianNumber('11')).toBe('одинадцять');
    expect(ukrainianNumber('21')).toBe('двадцять один');
    expect(ukrainianNumber('1000')).toBe('тисяча');
    expect(ukrainianNumber('2024')).toBe('дві тисячі двадцять чотири');
    expect(ukrainianNumber('5000')).toBe("п'ять тисяч");
    expect(ukrainianNumber('12000')).toBe('дванадцять тисяч');
    expect(ukrainianNumber('21000')).toBe('двадцять одна тисяча');
    expect(ukrainianNumber('1000001')).toBe('один мільйон один');
    expect(ukrainianNumber('342')).toBe('триста сорок два');
  });

  it('the review’s sentence keeps its number and its English word', () => {
    expect(ukrainianForTextVoice('У 2024 році я вивчав Python.')).toBe('У дві тисячі двадцять чотири році я вивчав пітон.');
  });

  it('decimals, percentages, and nothing left the voice cannot say', () => {
    expect(ukrainianForTextVoice('Зросло на 3,5% за рік.')).toBe("Зросло на три кома п'ять відсотків за рік.");
    expect(ukrainianForTextVoice('Shell, Chrome, JavaScript')).toBe('шелл, чроме, джаваскріпт');
    expect(ukrainianForTextVoice('Привіт 42 world!')).not.toMatch(/[0-9A-Za-z]/);
  });
});

describe('the eighth recheck (AB02): the zeros after the comma are part of the number', () => {
  it('tells three doses apart', () => {
    const said = (t: string) => ukrainianForTextVoice(t);
    expect(said('Доза 0,5 мг.')).toBe("Доза нуль кома п'ять мг.");
    expect(said('Доза 0,05 мг.')).toBe("Доза нуль кома нуль п'ять мг.");
    expect(said('Доза 0,005 мг.')).toBe("Доза нуль кома нуль нуль п'ять мг.");
    expect(new Set([said('Доза 0,5 мг.'), said('Доза 0,05 мг.'), said('Доза 0,005 мг.')]).size).toBe(3);
  });

  it('reads a dot the same way, and keeps a trailing zero', () => {
    expect(ukrainianForTextVoice('3.5')).toBe("три кома п'ять");
    expect(ukrainianForTextVoice('1,10')).toBe('один кома десять');
    expect(ukrainianForTextVoice('1,01')).toBe('один кома нуль один');
  });
});

describe('the ninth recheck (AC02): a sign before a number is said', () => {
  it('tells a negative dose from a positive one, however the minus is typed', () => {
    for (const minus of ['-', '\u2212', '\u2013']) {
      expect(ukrainianForTextVoice(`Зміна ${minus}0,05 мг.`)).toBe('Зміна мінус нуль кома нуль п\u2019ять мг.'.replace('\u2019', "'"));
    }
    expect(ukrainianForTextVoice('Зміна 0,05 мг.')).toBe("Зміна нуль кома нуль п'ять мг.");
    expect(ukrainianForTextVoice('-5')).toBe("мінус п'ять");
    expect(ukrainianForTextVoice('+5')).toBe("плюс п'ять");
  });

  it('leaves a hyphen that joins words alone', () => {
    expect(ukrainianForTextVoice('синьо-жовтий')).toBe('синьо-жовтий');
    // A range, not a negative year: the hyphen stays a hyphen between the two numbers.
    expect(ukrainianForTextVoice('2024-2025')).not.toContain('мінус');
    expect(ukrainianForTextVoice('о 10-15 хвилин')).not.toContain('мінус');
  });
});

describe('the tenth pass: dates and thousands', () => {
  it('reads a date as a date', () => {
    expect(ukrainianForTextVoice('05.10.2026')).toBe("п'яте жовтня дві тисячі двадцять шостого року");
    expect(ukrainianForTextVoice('Сталося 24.08.1991.')).toBe("Сталося двадцять четверте серпня тисяча дев'ятсот дев'яносто першого року.");
    expect(ukrainianForTextVoice('01.01.2000')).toBe('перше січня двохтисячного року');
    expect(ukrainianForTextVoice('31.12.2010')).toBe('тридцять перше грудня дві тисячі десятого року');
  });

  it('leaves something that only looks like a date as numbers', () => {
    expect(ukrainianForTextVoice('45.13.2026')).not.toContain('року');
  });

  it('reads grouped thousands as one number', () => {
    expect(ukrainianForTextVoice('1,000')).toBe('тисяча');
    expect(ukrainianForTextVoice('1,000,000')).toBe('один мільйон');
    expect(ukrainianForTextVoice('1 000')).toBe('тисяча');
    expect(ukrainianForTextVoice('25 000 гривень')).toBe("двадцять п'ять тисяч гривень");
    expect(ukrainianForTextVoice('3 500')).toBe("три тисячі п'ятсот");
  });

  it('keeps a Ukrainian decimal a decimal, and a phone number a phone number', () => {
    expect(ukrainianForTextVoice('3,500')).toBe("три кома п'ятсот");
    expect(ukrainianForTextVoice('0,005')).toBe("нуль кома нуль нуль п'ять");
    expect(ukrainianForTextVoice('067 123 45 67')).not.toContain('тисяч');
  });
});
