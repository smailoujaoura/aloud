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
