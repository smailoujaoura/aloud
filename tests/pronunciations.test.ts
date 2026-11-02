import { describe, it, expect } from 'vitest';
import { applyPronunciations } from '@/segment/pronunciations';

describe('applyPronunciations', () => {
  it('replaces whole words, ignoring case by default', () => {
    const rules = [{ from: 'GPU', to: 'G P U' }];
    expect(applyPronunciations('The GPU and the gpu.', rules)).toBe('The G P U and the G P U.');
  });

  it('never replaces inside another word', () => {
    expect(applyPronunciations('GPUs and aGPU', [{ from: 'GPU', to: 'G P U' }])).toBe('GPUs and aGPU');
  });

  it('prefers the longest matching rule', () => {
    const rules = [
      { from: 'New York', to: 'the city' },
      { from: 'New York Times', to: 'the paper' },
    ];
    expect(applyPronunciations('I read the New York Times in New York.', rules)).toBe(
      'I read the the paper in the city.',
    );
  });

  it('matches a phrase broken across lines or spaces', () => {
    expect(applyPronunciations('the New\n   York skyline', [{ from: 'New York', to: 'NYC' }])).toBe('the NYC skyline');
  });

  it('handles rules that start or end with punctuation', () => {
    expect(applyPronunciations('Written in C++ today.', [{ from: 'C++', to: 'C plus plus' }])).toBe(
      'Written in C plus plus today.',
    );
  });

  it('respects case when a rule asks for it', () => {
    const rules = [{ from: 'US', to: 'U S', matchCase: true }];
    expect(applyPronunciations('The US told us.', rules)).toBe('The U S told us.');
  });

  it('ignores a rule that has nothing to say yet, instead of deleting the word', () => {
    expect(applyPronunciations('The GPU is fast.', [{ from: 'GPU', to: '  ' }])).toBe('The GPU is fast.');
  });

  it('ignores empty rules and leaves text alone with none', () => {
    expect(applyPronunciations('Nothing changes.', [{ from: '  ', to: 'x' }])).toBe('Nothing changes.');
    expect(applyPronunciations('Nothing changes.', undefined)).toBe('Nothing changes.');
  });

  it('escapes regular-expression characters in what is written', () => {
    expect(applyPronunciations('Costs $5 (approx.)', [{ from: '(approx.)', to: 'roughly' }])).toBe('Costs $5 roughly');
  });
});

describe('a fix for one language', () => {
  const rules = [
    { from: 'Nguyen', to: 'Win', language: 'en' },
    { from: 'GPU', to: 'G P U' },
  ];

  it('applies only in passages in that language (#5)', () => {
    expect(applyPronunciations('Nguyen has a GPU', rules, 'en-GB')).toBe('Win has a G P U');
    expect(applyPronunciations('Nguyen a un GPU', rules, 'fr')).toBe('Nguyen a un G P U');
  });

  it('a fix for every language applies even when the passage language is unknown', () => {
    expect(applyPronunciations('Nguyen has a GPU', rules)).toBe('Nguyen has a G P U');
  });

  it('is kept when settings are saved, and a malformed language is dropped', async () => {
    const { sanitizeSettings, DEFAULT_SETTINGS } = await import('@/shared/settings');
    const saved = sanitizeSettings({ ...DEFAULT_SETTINGS, pronunciations: [{ from: 'a', to: 'b', language: 'fr' }, { from: 'c', to: 'd', language: 'French!' }] } as never);
    expect(saved.pronunciations).toEqual([{ from: 'a', to: 'b', language: 'fr' }, { from: 'c', to: 'd' }]);
  });
});
