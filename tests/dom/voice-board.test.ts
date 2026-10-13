// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { renderMyVoices, renderVoiceBoard, wiredVoices } from '@/entrypoints/options/voice-board';
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
    setAutoLanguage: vi.fn(),
  } as unknown as PanelContext;
}

vi.mock('@/engine/installed-voices', () => ({ piperDownloaded: () => false, sharedModelInstalled: (e: string) => e === 'kokoro' }));

describe('who reads what', () => {
  it('a row per language, the voice reading it marked, a pick rewires it', () => {
    const c = ctx({ languageVoices: { it: { engine: 'kokoro', voice: 'im_nicola' } } });
    const host = document.createElement('div');
    renderVoiceBoard(host, c, vi.fn());
    const rows = [...host.querySelectorAll('.vb-row')];
    expect(rows.map((r) => r.querySelector('.vb-lang b')!.textContent)).toEqual(['English', 'Italian']);
    const italian = rows[1]!;
    expect(italian.querySelector('.vb-face.is-reading')!.textContent).toContain('Nicola');
    expect(italian.querySelector('.vb-auto')!.getAttribute('aria-checked')).toBe('false');
    [...italian.querySelectorAll<HTMLButtonElement>('.vb-face')].find((f) => f.textContent!.includes('Sara'))!.click();
    expect(c.setLanguageVoice).toHaveBeenCalledWith('it', { engine: 'kokoro', voice: 'if_sara' });
    italian.querySelector<HTMLButtonElement>('.vb-auto')!.click();
    expect(c.setLanguageVoice).toHaveBeenCalledWith('it', null);
  });

  it('"keep only the ones I use" keeps one voice per language — the wired ones', () => {
    const c = ctx();
    expect([...wiredVoices(c)].sort()).toEqual(['kokoro:af_heart', 'kokoro:if_sara']);
    const host = document.createElement('div');
    renderMyVoices(host, c, vi.fn());
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Keep only the ones I use')!.click();
    expect(c.setHiddenVoices).toHaveBeenCalledWith(['kokoro:af_bella', 'kokoro:im_nicola']);
  });

  it('put-away voices leave the board and the gallery', () => {
    const c = ctx({ hiddenVoices: ['kokoro:af_bella'] });
    const board = document.createElement('div');
    renderVoiceBoard(board, c, vi.fn());
    expect(board.textContent).not.toContain('Bella');
    const mine = document.createElement('div');
    renderMyVoices(mine, c, vi.fn());
    expect(mine.textContent).toContain('1 put away');
  });
});
