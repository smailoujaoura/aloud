import { describe, expect, it } from 'vitest';
import { rebase, rebaseRules } from '@/entrypoints/options/rebase';

describe('a panel’s save, on top of what is stored now', () => {
  it('a key changed in the panel, another changed meanwhile elsewhere: both kept', () => {
    const base = { faster: 'd', slower: 's', reset: 'r' };
    const now = { faster: 'd', slower: 'a', reset: 'r' }; // another device changed "slower"
    const mine = { ...base, faster: 'f' }; // the panel's copy, with its one change
    expect(rebase(now, base, mine)).toEqual({ faster: 'f', slower: 'a', reset: 'r' });
  });

  it('nested groups too (the video speed panel’s keys inside mediaSpeed)', () => {
    const base = { step: 0.25, keys: { faster: 'd', slower: 's' }, neverOn: ['a.com'] };
    const now = { step: 0.5, keys: { faster: 'd', slower: 'x' }, neverOn: ['a.com', 'b.com'] };
    const mine = { ...base, keys: { faster: 'g', slower: 's' } };
    expect(rebase(now, base, mine)).toEqual({ step: 0.5, keys: { faster: 'g', slower: 'x' }, neverOn: ['a.com', 'b.com'] });
  });

  it('site lists item by item: added here and there both kept, removed here removed', () => {
    expect(rebase(['a.com', 'c.com'], ['a.com'], ['a.com', 'b.com'])).toEqual(['a.com', 'c.com', 'b.com']);
    expect(rebase(['a.com', 'c.com'], ['a.com'], [])).toEqual(['c.com']);
  });

  it('pronunciations: a rule added on the phone survives a save in the computer’s stale editor', () => {
    const base = [{ from: 'GIF', to: 'jif' }];
    const now = [{ from: 'GIF', to: 'jif' }, { from: 'nginx', to: 'engine x' }]; // from the phone
    const mine = [{ from: 'GIF', to: 'jif' }, { from: 'SQL', to: 'sequel' }]; // typed here
    expect(rebaseRules(now, base, mine).map((r) => r.from)).toEqual(['GIF', 'nginx', 'SQL']);
    // A rule deleted in the editor is deleted, the phone's stays.
    expect(rebaseRules(now, base, []).map((r) => r.from)).toEqual(['nginx']);
  });
});
