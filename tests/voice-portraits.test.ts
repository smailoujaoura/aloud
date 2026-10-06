import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allPortraitFiles, voicePortrait } from '@/ui/voice-portraits';
import { isBestVoice, voiceRank } from '@/ui/voice-quality';
import catalogue from '../public/models.json';

describe('voicePortrait', () => {
  it('gives every quality tier of a Piper voice the same face', () => {
    expect(voicePortrait('piper', 'en_US-lessac-high')?.file).toBe('/portraits/piper-lessac.webp');
    expect(voicePortrait('piper', 'en_US-lessac-medium')?.file).toBe('/portraits/piper-lessac.webp');
  });

  it('leaves the other voices to their drawn avatar', () => {
    expect(voicePortrait('piper', 'en_US-amy-medium')).toBeNull();
    expect(voicePortrait('supertonic', 'F1')).toBeNull();
  });

  it('gives every Kokoro voice a face — there are few enough to draw them all', () => {
    const without = Object.keys(catalogue.kokoro.voices).filter((id) => !voicePortrait('kokoro', id));
    expect(without).toEqual([]);
  });

  it('a face is not the same thing as a place at the front of the list', () => {
    // am_echo has a portrait but is graded D: it is ranked by its grade, not listed first.
    expect(voicePortrait('kokoro', 'am_echo')).not.toBeNull();
    expect(isBestVoice('kokoro', 'am_echo')).toBe(false);
    expect(isBestVoice('kokoro', 'af_heart')).toBe(true);
  });

  it('ships a file for every portrait it names', () => {
    const missing = allPortraitFiles().filter((f) => !existsSync(resolve('public', `.${f}`)));
    expect(missing).toEqual([]);
  });
});

describe('voiceRank', () => {
  it('puts the voices with a portrait first, in their own order', () => {
    const m = manifest();
    expect(voiceRank('piper', 'en_GB-alba-medium', m)).toBeLessThan(voiceRank('piper', 'en_US-amy-medium', m));
    expect(voiceRank('kokoro', 'af_heart', m)).toBeLessThan(voiceRank('kokoro', 'am_echo', m));
    // Piper's best come before Kokoro's, so one order covers the whole catalogue.
    expect(voiceRank('piper', 'en_GB-alba-medium', m)).toBeLessThan(voiceRank('kokoro', 'af_heart', m));
  });

  it('ranks the rest by recording quality, then by Kokoro grade', () => {
    const m = manifest();
    const high = [{ quality: 'high' }] as never;
    const low = [{ quality: 'low' }] as never;
    expect(voiceRank('piper', 'en_US-x-high', m, high)).toBeLessThan(voiceRank('piper', 'en_US-x-low', m, low));
    expect(voiceRank('kokoro', 'bf_isabella', m)).toBeLessThan(voiceRank('kokoro', 'am_echo', m));
  });
});

function manifest() {
  return {
    piper: { 'en_US-amy-medium': { quality: 'medium' } },
    kokoro: { voices: { am_echo: { grade: 'D' }, bf_isabella: { grade: 'C' }, af_heart: { grade: 'A' } } },
  } as never;
}
