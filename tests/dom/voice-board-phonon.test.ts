// @vitest-environment happy-dom
// Phonon is the default on every computer, and comes with French, Spanish, German and Portuguese
// voices marked experimental: they must not give every new reader four language rows.
import { describe, it, expect, vi } from 'vitest';
import { renderVoiceBoard } from '@/entrypoints/options/voice-board';
import type { PanelContext } from '@/entrypoints/options/voice-panels';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings';
import type { ModelManifest } from '@/engine/engines/types';

const voice = (label: string, language: string) => ({ label, language, gender: 'female', description: '', sha256: '' });
const manifest = {
  piper: {},
  kokoro: { voices: {} },
  phonon: { experimentalLanguages: ['fr', 'es', 'de', 'pt'], voices: { zoey: voice('Zoey', 'en-US'), noemie: voice('Noémie', 'fr-FR'), noa: voice('Noa', 'es-ES') } },
} as unknown as ModelManifest;

vi.mock('@/engine/installed-voices', () => ({ piperDownloaded: () => false, sharedModelInstalled: (e: string) => e === 'phonon' }));

function ctx(over: Partial<Settings>): PanelContext {
  return {
    settings: { ...DEFAULT_SETTINGS, engine: 'phonon', phononVoice: 'zoey', languageVoices: {}, ...over },
    manifest,
    sizes: new Map(),
    filter: '',
    refresh: vi.fn(), useVoice: vi.fn(), flashSaved: vi.fn(), flashError: vi.fn(), setLanguageVoice: vi.fn(),
    chooseVoice: vi.fn(), setUnvoiced: vi.fn(), setLanguageRemoved: vi.fn(), setOtherVoice: vi.fn(), setAutoLanguage: vi.fn(),
  } as unknown as PanelContext;
}

describe('Phonon on the board', () => {
  it('only English gets a row; the experimental languages are named in the last row', () => {
    const host = document.createElement('div');
    renderVoiceBoard(host, ctx({ unvoicedLanguages: 'skip' }), vi.fn());
    expect([...host.querySelectorAll('.vb-row:not(.vb-others) .vb-lang b')].map((b) => b.textContent)).toEqual(['English']);
    expect(host.querySelector('.vb-others .vb-lang')!.textContent).toContain('Phonon reads, with mistakes, French, Spanish in their own language.');
  });

  it('a language given one of them on purpose gets its row', () => {
    const host = document.createElement('div');
    renderVoiceBoard(host, ctx({ languageVoices: { fr: { engine: 'phonon', voice: 'noemie' } } }), vi.fn());
    expect([...host.querySelectorAll('.vb-row:not(.vb-others) .vb-lang b')].map((b) => b.textContent)).toContain('French');
  });
});
