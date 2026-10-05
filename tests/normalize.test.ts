import { describe, it, expect } from 'vitest';
import { normalizeForSpeech, isSpeakable } from '@/segment/normalize';

describe('normalizeForSpeech', () => {
  it('replaces URLs with a placeholder', () => {
    expect(normalizeForSpeech('See https://example.com/x?y=1 for more')).toBe('See link for more');
  });

  it('replaces e-mail addresses', () => {
    expect(normalizeForSpeech('Write to a.b-c@sub.example.co.uk now')).toBe('Write to e-mail address now');
  });

  it('expands abbreviations when enabled', () => {
    expect(normalizeForSpeech('e.g. this, i.e. that', { expandAbbreviations: true })).toBe(
      'for example this, that is that',
    );
  });

  it('keeps abbreviations literal when disabled', () => {
    expect(normalizeForSpeech('e.g. this', { expandAbbreviations: false })).toBe('e.g. this');
  });

  it('turns numeric ranges into "to"', () => {
    expect(normalizeForSpeech('pages 5-10 today')).toBe('pages 5 to 10 today');
  });

  it('expands & and drops trademark glyphs', () => {
    expect(normalizeForSpeech('Tom & Jerry™')).toBe('Tom and Jerry');
  });

  it('collapses repeated terminal punctuation and whitespace', () => {
    expect(normalizeForSpeech('Wow!!!   Really???')).toBe('Wow! Really?');
  });

  it('strips emoji', () => {
    expect(normalizeForSpeech('nice 👍🏽 work 🎉')).toBe('nice work');
  });

  it('drops a leading list bullet', () => {
    expect(normalizeForSpeech('• first item')).toBe('first item');
  });
});

describe('isSpeakable', () => {
  it('is false for punctuation-only text', () => {
    expect(isSpeakable('—— …')).toBe(false);
    expect(isSpeakable('')).toBe(false);
  });
  it('is true when letters or digits remain', () => {
    expect(isSpeakable('a')).toBe(true);
    expect(isSpeakable('3')).toBe(true);
  });
});

describe('reading URLs aloud', () => {
  it('leaves the address in place instead of repeating the sentence', () => {
    // The audit's A11: "Visit https://example.com now." became
    // "Visit Visit https://example.com now. now." because the whole sentence was passed as the
    // replacement for each URL.
    expect(normalizeForSpeech('Visit https://example.com now.', { urlReplacement: null })).toBe('Visit https://example.com now.');
  });

  it('handles several addresses and the punctuation around them', () => {
    expect(normalizeForSpeech('See https://a.example and https://b.example, then stop.', { urlReplacement: null })).toBe(
      'See https://a.example and https://b.example, then stop.',
    );
    expect(normalizeForSpeech('See https://a.example and https://b.example.')).toBe('See link and link');
  });
});

describe('the independent review’s cases', async () => {
  const { normalizeForSpeech } = await import('@/segment/normalize');
  const say = (text: string, language = 'en-US') => normalizeForSpeech(text, { language });

  it('"VS Code" is a name, "a vs b" is versus', () => {
    expect(say('Open it in VS Code.')).toBe('Open it in VS Code.');
    expect(say('Cats vs dogs, and cats vs. dogs.')).toBe('Cats versus dogs, and cats versus dogs.');
  });

  it('a hyphen between numbers is a range only when it looks like one', () => {
    expect(say('Call 555-1234 today.')).toBe('Call 555-1234 today.');
    expect(say('Due 2024-10-05.')).toBe('Due 2024-10-05.');
    expect(say('Open 9-05 daily.')).toBe('Open 9-05 daily.');
    expect(say('Code 1-2-3.')).toBe('Code 1-2-3.');
    expect(say('Pages 5-10 and 1990-1995.')).toBe('Pages 5 to 10 and 1990 to 1995.');
    expect(say('Between 20–25 people.')).toBe('Between 20 to 25 people.');
  });

  it('a German voice gets no English words', () => {
    const de = say('Bei 20–25 °C kamen Müller & Söhne, siehe www.example.de.', 'de-DE');
    expect(de).not.toMatch(/\b(and|to|degrees|link)\b/);
    expect(de).toContain('Müller & Söhne');
  });
});
