// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { ControlBar, type ControlBarCallbacks, type LanguageInfo } from '@/ui/control-bar';

function bar(over: Partial<ControlBarCallbacks> = {}) {
  const noop = () => undefined;
  const cb = {
    onPlay: noop, onPause: noop, onPrev: noop, onNext: noop, onSeekFraction: noop, onSpeed: noop, onVoice: vi.fn(),
    onToggleTapToSeek: noop, onSnapToCurrent: noop, onSaveNote: noop, onBackALittle: noop, onSleep: noop,
    onExportStart: noop, onExportCancel: noop, onExportSave: noop, onOpenSettings: noop, onOpenWalkthrough: noop,
    onTipsDismissed: noop, onClose: noop, onVoiceLock: vi.fn(), onMissingVoice: vi.fn(), onManageVoices: vi.fn(), onFollow: vi.fn(),
    ...over,
  } as ControlBarCallbacks;
  const b = new ControlBar(document, cb, { speed: 1, tapToSeek: false, theme: 'light' });
  return { b, cb, root: (b as unknown as { root: ShadowRoot }).root };
}

const info = (over: Partial<LanguageInfo> = {}): LanguageInfo => ({
  language: 'it', name: 'Italian', how: 'detected', voiceLabel: 'Sara', missing: false, skipped: false, manual: false, auto: true,
  languages: [{ code: 'en', name: 'English' }, { code: 'it', name: 'Italian' }], voices: [], preferred: '', ...over,
});

const voices = [
  { value: 'piper:en_GB-alba-medium', name: 'Alba', meta: 'Piper · British English', language: 'en', portrait: null },
  { value: 'kokoro:if_sara', name: 'Sara', meta: 'Kokoro · Italian', language: 'it', portrait: null },
  { value: 'kokoro:im_nicola', name: 'Nicola', meta: 'Kokoro · Italian', language: 'it', portrait: null },
];

describe('the voice and language button', () => {
  it('shows the voice reading and the passage language on one button', () => {
    const { b, root } = bar();
    b.setVoices(voices, 'kokoro:if_sara');
    b.setLanguage(info());
    const btn = root.querySelector<HTMLButtonElement>('button.voice')!;
    expect(btn.hidden).toBe(false);
    expect(btn.querySelector('.voice-name')!.textContent).toBe('Sara');
    expect(btn.querySelector('.badge-lang')!.textContent).toBe('IT');
    expect(root.querySelector('button.lang')).toBeNull();
  });

  it('lists voices with the passage language first, and a pick goes to the session', () => {
    const { b, cb, root } = bar();
    b.setVoices(voices, 'kokoro:if_sara');
    b.setLanguage(info());
    root.querySelector<HTMLButtonElement>('button.voice')!.click();
    const groups = [...root.querySelectorAll('.voice-group')].map((g) => g.textContent);
    expect(groups[0]).toBe('Italian');
    const rows = [...root.querySelectorAll<HTMLButtonElement>('.voice-row')];
    expect(rows.map((r) => r.querySelector('b')!.textContent)).toEqual(['Sara', 'Nicola', 'Alba']);
    rows[1]!.click();
    expect(cb.onVoice).toHaveBeenCalledWith('kokoro:im_nicola');
  });

  it('a language with no voice says so, with get / skip, and never claims a voice for it', () => {
    const { b, cb, root } = bar();
    b.setVoices(voices.slice(0, 1), 'piper:en_GB-alba-medium');
    b.setLanguage(info({ language: 'de', name: 'German', missing: true, voiceLabel: 'Alba' }));
    expect(root.querySelector('button.voice')!.classList.contains('missing')).toBe(true);
    root.querySelector<HTMLButtonElement>('button.voice')!.click();
    const warn = root.querySelector('.menu-text.warn')!.textContent!;
    expect(warn).toContain('No German voice downloaded');
    const actions = [...root.querySelectorAll<HTMLButtonElement>('.menu-actions button')];
    actions.find((a) => a.textContent === 'Skip German')!.click();
    expect(cb.onMissingVoice).toHaveBeenCalledWith('de', 'skip');
  });

  it('follow: on, resting away, and off read differently and call the session', () => {
    const { b, cb, root } = bar();
    const follow = root.querySelector<HTMLButtonElement>('button.follow')!;
    b.setFollow('on');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    b.setFollow('away');
    expect(follow.classList.contains('offscreen')).toBe(true);
    b.setFollow('off');
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    follow.click();
    expect(cb.onFollow).toHaveBeenCalled();
  });
});

describe('a closed bar', () => {
  it('lets go of its place in the shared typing registry', () => {
    const roots = () => (globalThis as { __aloudTypingRoots?: Set<ShadowRoot> }).__aloudTypingRoots;
    const { b, root } = bar();
    expect(roots()?.has(root)).toBe(true);
    b.dispose();
    // Held there, every bar a tab ever showed stayed in memory until the page was left.
    expect(roots()?.has(root)).toBe(false);
  });
});
