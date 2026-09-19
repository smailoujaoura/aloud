import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allPortraitFiles, voicePortrait } from '@/ui/voice-portraits';

describe('voicePortrait', () => {
  it('gives every quality tier of a Piper voice the same face', () => {
    expect(voicePortrait('piper', 'en_US-lessac-high')?.file).toBe('/portraits/piper-lessac.webp');
    expect(voicePortrait('piper', 'en_US-lessac-medium')?.file).toBe('/portraits/piper-lessac.webp');
  });

  it('leaves the other voices to their drawn avatar', () => {
    expect(voicePortrait('piper', 'en_US-amy-medium')).toBeNull();
    expect(voicePortrait('kokoro', 'am_echo')).toBeNull();
    expect(voicePortrait('supertonic', 'F1')).toBeNull();
  });

  it('ships a file for every portrait it names', () => {
    const missing = allPortraitFiles().filter((f) => !existsSync(resolve('public', `.${f}`)));
    expect(missing).toEqual([]);
  });
});
