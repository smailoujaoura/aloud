// @vitest-environment happy-dom
// Review of 94e2832, finding 2: with only Supertonic installed and "Every other language" on Skip,
// the board showed only English and "Not read", while the reader read German in German.
import { describe, it, expect, vi } from 'vitest';
import { renderVoiceBoard } from '@/entrypoints/options/voice-board';
import type { PanelContext } from '@/entrypoints/options/voice-panels';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings';
import type { ModelManifest } from '@/engine/engines/types';
import { routeFor } from '@/content/voice-routing';
import { supertonicVoices } from '@/shared/supertonic-voices';

const manifest = {
  piper: {},
  kokoro: { voices: {} },
  supertonic: { voices: { F1: { label: 'Female 1', gender: 'female' } }, languages: ['en', 'de', 'ru'] },
} as unknown as ModelManifest;

vi.mock('@/engine/installed-voices', () => ({ piperDownloaded: () => false, sharedModelInstalled: (e: string) => e === 'supertonic' }));

function ctx(over: Partial<Settings>): PanelContext {
  return {
    settings: { ...DEFAULT_SETTINGS, engine: 'supertonic', supertonicVoice: 'F1@en', languageVoices: { en: { engine: 'supertonic', voice: 'F1@en' } }, ...over },
    manifest,
    sizes: new Map(),
    filter: '',
    refresh: vi.fn(), useVoice: vi.fn(), flashSaved: vi.fn(), flashError: vi.fn(), setLanguageVoice: vi.fn(),
    chooseVoice: vi.fn(), setUnvoiced: vi.fn(), setLanguageRemoved: vi.fn(), setOtherVoice: vi.fn(), setAutoLanguage: vi.fn(),
  } as unknown as PanelContext;
}

const render = (c: PanelContext): HTMLElement => {
  const host = document.createElement('div');
  renderVoiceBoard(host, c, vi.fn());
  return host;
};

describe('Supertonic and "every other language"', () => {
  it('the last row says which languages Supertonic reads in their own voice, so Skip means the rest', () => {
    const c = ctx({ unvoicedLanguages: 'skip' });
    const host = render(c);
    expect([...host.querySelectorAll('.vb-row:not(.vb-others) .vb-lang b')].map((b) => b.textContent)).toEqual(['English']);
    const others = host.querySelector('.vb-others .vb-lang')!.textContent!;
    expect(others).toContain('The rest not read');
    expect(others).toContain('Supertonic reads German, Russian in their own language.');
    // And the reader does exactly that: German in German, not skipped.
    const installed = supertonicVoices(manifest).map((v) => ({ engine: 'supertonic' as const, id: v.id, label: v.label, language: v.language }));
    const route = routeFor('de', {
      auto: true, manual: null, saved: installed[0]!, preferences: c.settings.languageVoices, installed,
      skip: new Set(), unvoiced: 'skip', removed: new Set(), other: null,
    });
    expect(route).toMatchObject({ kind: 'voice', voice: { id: 'F1@de' } });
  });

  it('a language removed from the board is not claimed for Supertonic', () => {
    const host = render(ctx({ unvoicedLanguages: 'skip', removedLanguages: ['de'] }));
    expect(host.querySelector('.vb-others .vb-lang')!.textContent).toContain('Supertonic reads Russian in their own language.');
  });
});
