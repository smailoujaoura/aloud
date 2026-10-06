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
