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
