// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { OTHER_LANGUAGES, renderVoiceBoard } from '@/entrypoints/options/voice-board';
import type { PanelContext } from '@/entrypoints/options/voice-panels';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings';
import type { ModelManifest } from '@/engine/engines/types';

const manifest = {
  piper: {},
  kokoro: {
    voices: {
      af_heart: { label: 'Heart', language: 'en-us', gender: 'female' },
      af_bella: { label: 'Bella', language: 'en-us', gender: 'female' },
      if_sara: { label: 'Sara', language: 'it', gender: 'female' },
      im_nicola: { label: 'Nicola', language: 'it', gender: 'male' },
    },
  },
} as unknown as ModelManifest;

function ctx(over: Partial<Settings> = {}): PanelContext {
  return {
    settings: { ...DEFAULT_SETTINGS, engine: 'kokoro', kokoroVoice: 'af_heart', ...over },
    manifest,
    // Kokoro counts as installed when its model files are cached (installed-voices.ts).
    sizes: new Map([['https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx', 1]]),
    filter: '',
    refresh: vi.fn(),
    useVoice: vi.fn(),
    flashSaved: vi.fn(),
    flashError: vi.fn(),
    setHiddenVoices: vi.fn(),
    setLanguageVoice: vi.fn(),
    chooseVoice: vi.fn(),
    setUnvoiced: vi.fn(),
    setLanguageRemoved: vi.fn(),
    setOtherVoice: vi.fn(),
    setAutoLanguage: vi.fn(),
  } as unknown as PanelContext;
}

vi.mock('@/engine/installed-voices', () => ({ piperDownloaded: () => false, sharedModelInstalled: (e: string) => e === 'kokoro' }));

describe('who reads what', () => {
  const render = (c: PanelContext): HTMLElement => {
    const host = document.createElement('div');
    renderVoiceBoard(host, c, vi.fn());
    return host;
  };
  const rows = (host: HTMLElement) => [...host.querySelectorAll('.vb-row:not(.vb-others)')];

  it('a row per language, each with Auto — English too — a flag, and a play button on every face', () => {
    const host = render(ctx());
    expect(rows(host).map((r) => r.querySelector('.vb-lang b')!.textContent)).toEqual(['English', 'Italian']);
    for (const row of rows(host)) expect(row.querySelector('.vb-auto')).not.toBeNull();
    expect(rows(host)[0]!.querySelector<HTMLImageElement>('.vb-flag')!.getAttribute('src')).toBe('/flags/us.svg');
    expect(host.querySelectorAll('.vb-pick').length).toBe(host.querySelectorAll('.vb-pick .vb-play').length);
    // No switch to turn language switching off: a language is removed instead.
    expect(host.querySelector('#matchPageLanguage')).toBeNull();
  });

  it('a pick chooses for that language; Auto gives it back', () => {
    const c = ctx({ languageVoices: { it: { engine: 'kokoro', voice: 'im_nicola' } } });
    const italian = rows(render(c))[1]!;
    expect(italian.querySelector('.vb-face.is-reading')!.textContent).toContain('Nicola');
    [...italian.querySelectorAll<HTMLButtonElement>('.vb-face')].find((f) => f.textContent!.includes('Sara'))!.click();
    expect(c.chooseVoice).toHaveBeenCalledWith('it', 'kokoro', 'if_sara');
    italian.querySelector<HTMLButtonElement>('.vb-auto')!.click();
    expect(c.setLanguageVoice).toHaveBeenCalledWith('it', null);
  });

  it('a language can be removed, and is then listed under every other language to bring back', () => {
    const c = ctx();
    rows(render(c))[1]!.querySelector<HTMLButtonElement>('.vb-remove')!.click();
    expect(c.setLanguageRemoved).toHaveBeenCalledWith('it', true);
    const gone = ctx({ removedLanguages: ['it'] });
    const host = render(gone);
    expect(rows(host).map((r) => r.querySelector('.vb-lang b')!.textContent)).toEqual(['English']);
    host.querySelector<HTMLButtonElement>('.vb-others .vb-back')!.click();
    expect(gone.setLanguageRemoved).toHaveBeenCalledWith('it', false);
  });

  it('every other language: any voice can read it, Auto, or Skip', () => {
    const c = ctx();
    const others = render(c).querySelector('.vb-others')!;
    expect(others.querySelectorAll('.vb-pick').length).toBe(4);
    [...others.querySelectorAll<HTMLButtonElement>('.vb-face')].find((f) => f.textContent!.includes('Sara'))!.click();
    expect(c.chooseVoice).toHaveBeenCalledWith(OTHER_LANGUAGES, 'kokoro', 'if_sara');
    [...others.querySelectorAll<HTMLButtonElement>('.vb-auto')].find((b) => b.textContent === 'Skip')!.click();
    expect(c.setUnvoiced).toHaveBeenCalledWith('skip');
  });

  it('put-away voices stay on the board to choose from, dimmed', () => {
    const board = render(ctx({ hiddenVoices: ['kokoro:af_bella'] }));
    const bella = [...rows(board)[0]!.querySelectorAll('.vb-pick')].find((p) => p.textContent!.includes('Bella'))!;
    expect(bella.classList.contains('is-away')).toBe(true);
  });
});
