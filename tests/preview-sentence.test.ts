import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { runtime: { getURL: (p: string) => p } } }));

const { previewSentence, PREVIEW_SENTENCE } = await import('@/ui/voice-preview');
const manifest = (await import('../public/models.json')).default as unknown as {
  piper: Record<string, { language: string }>;
  kokoro: { voices: Record<string, { language: string }> };
  supertonic: { languages: string[] };
};

describe('what a voice says when previewed', () => {
  it('a German voice speaks German, not the English sample', () => {
    expect(previewSentence('de_DE')).not.toBe(PREVIEW_SENTENCE);
    expect(previewSentence('de_DE')).toMatch(/Farbverlauf|Regenbogen/);
  });

  it('every voice language has its own sentence; English keeps the English one', () => {
    // Supertonic's too: every style reads every one of its languages (`F1@ja`), and a Japanese
    // voice previewed with the English sentence was the bug.
    const tags = [...Object.values(manifest.piper), ...Object.values(manifest.kokoro.voices)].map((v) => v.language).concat(manifest.supertonic.languages);
    for (const tag of tags) {
      if (tag.toLowerCase().startsWith('en')) expect(previewSentence(tag)).toBe(PREVIEW_SENTENCE);
      else expect(previewSentence(tag), tag).not.toBe(PREVIEW_SENTENCE);
    }
  });

  it('keeps previews short: a few seconds of speech', () => {
    const tags = Object.values(manifest.piper).map((v) => v.language);
    for (const tag of tags) expect(previewSentence(tag).length, tag).toBeLessThanOrEqual(160);
  });
});
