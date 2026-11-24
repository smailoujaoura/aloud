// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ touchFirst: false, granted: true }));
vi.mock('@/shared/browser-env', () => ({ capabilities: () => ({ touchFirst: env.touchFirst }) }));
vi.mock('wxt/browser', () => ({ browser: { permissions: { request: vi.fn(async () => env.granted) } } }));
vi.mock('@/media-speed/site-speeds', () => ({ clearSiteSpeeds: vi.fn(), loadSiteSpeeds: vi.fn(async () => ({})) }));

import { renderMediaSpeedPanel } from '@/entrypoints/options/media-speed-panel';
import { browser } from 'wxt/browser';
import { DEFAULT_MEDIA_SPEED } from '@/shared/settings';

const render = (alwaysOn: string[] = []) => {
  const host = document.createElement('div');
  const save = vi.fn(async () => {});
  renderMediaSpeedPanel(host, { settings: { ...DEFAULT_MEDIA_SPEED, alwaysOn }, save, toast: vi.fn() });
  return { host, save };
};

describe('video speed settings on a phone', () => {
  it('lead with the button on every video, and have no keys', () => {
    env.touchFirst = true;
    const { host } = render();
    expect(host.querySelector('.row.check')!.textContent).toContain('Show the speed button on every video');
    expect(host.textContent).not.toContain('While a page has a video or audio');
    expect(host.textContent).toContain('one tap of − or +');
    // Only what the button uses: the keys' own speeds are set on a computer.
    expect(host.querySelector('[aria-label="Your speed"]')).toBeNull();
    expect(host.querySelector('.preset-chips')).toBeNull();
  });

  it('the switch asks for every site, from the tap, and then saves it', async () => {
    env.touchFirst = true;
    env.granted = true;
    const { host, save } = render(['youtube.com']);
    const box = host.querySelector<HTMLInputElement>('.row.check input')!;
    box.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ alwaysOn: ['youtube.com', '*'] }));
    expect(browser.permissions.request).toHaveBeenCalledWith({ origins: ['*://*/*'] });
  });

  it('refused, it stays off and saves nothing', async () => {
    env.touchFirst = true;
    env.granted = false;
    const { host, save } = render();
    const box = host.querySelector<HTMLInputElement>('.row.check input')!;
    box.click();
    await vi.waitFor(() => expect(box.checked).toBe(false));
    expect(save).not.toHaveBeenCalled();
  });

  it('on a computer: the keys, no phone switch', () => {
    env.touchFirst = false;
    const { host } = render();
    expect(host.textContent).toContain('While a page has a video or audio');
    expect(host.textContent).not.toContain('Show the speed button on every video');
  });

  it('on a computer the speed button on videos can be turned off', () => {
    env.touchFirst = false;
    const { host, save } = render();
    const row = [...host.querySelectorAll('.row.check')].find((r) => r.textContent?.includes('Show a speed button on videos'))!;
    const box = row.querySelector('input')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenCalledWith({ showButton: false });
  });

  it('a phone always has the button: no switch for it there', () => {
    env.touchFirst = true;
    const { host } = render();
    expect(host.textContent).not.toContain('Show a speed button on videos');
  });
});

describe('video speed settings on a computer: each key beside what it uses (#12)', () => {
  const draw = (over: Partial<typeof DEFAULT_MEDIA_SPEED> = {}) => {
    env.touchFirst = false;
    const host = document.createElement('div');
    const save = vi.fn(async () => {});
    renderMediaSpeedPanel(host, { settings: { ...DEFAULT_MEDIA_SPEED, ...over }, save, toast: vi.fn() });
    const ids: Record<string, string> = {
      'Faster and slower': 'step',
      'Your speed': 'your-speed',
      'Preset speeds': 'presets',
      'Rewind and skip': 'seek',
    };
    const card = (title: string) => host.querySelector<HTMLElement>(`.km-row[data-act="${ids[title]}"]`)!;
    return { host, save, card };
  };
  const keysIn = (card: HTMLElement) => [...card.querySelectorAll('.key-button')].map((b) => b.textContent);

  it('a key and its value share a line: G with Your speed, D and S with the step, Shift+D and Shift+S with the presets', () => {
    const { card } = draw({ preferred: 1.5 });
    expect(keysIn(card('Your speed'))).toEqual(['G']);
    expect(card('Your speed').querySelector<HTMLSelectElement>('select')!.value).toBe('1.5');
    expect(keysIn(card('Faster and slower'))).toEqual(['S', 'D']);
    expect(card('Faster and slower').querySelector<HTMLSelectElement>('select')!.value).toBe('0.25');
    expect(keysIn(card('Preset speeds'))).toEqual(['⇧ S', '⇧ D']);
    expect(card('Preset speeds').querySelector('.key-button')!.getAttribute('aria-label')).toBe('Previous preset key: Shift + S');
    expect(keysIn(card('Rewind and skip'))).toEqual(['Z', 'X']);
  });

  it('Your speed can be 1.75×, and at 1× says why G does nothing', () => {
    const { card, save } = draw({ preferred: 1 });
    const picker = card('Your speed').querySelector<HTMLSelectElement>('select')!;
    expect([...picker.options].map((o) => o.value)).toContain('1.75');
    expect(card('Your speed').textContent).toContain('At 1× it has nowhere to go');
    picker.value = '1.75';
    picker.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenCalledWith({ preferred: 1.75 });
    expect(draw({ preferred: 1.75 }).card('Your speed').textContent).not.toContain('nowhere to go');
  });

  it('presets are chips: ✕ takes one out, a typed speed adds one, and the last one stays', () => {
    const { card, save } = draw({ presets: [1, 2, 4] });
    const presets = card('Preset speeds');
    presets.querySelector<HTMLButtonElement>('[aria-label="Remove 4×"]')!.click();
    expect(save).toHaveBeenLastCalledWith({ presets: [1, 2] });
    const add = presets.querySelector<HTMLInputElement>('.preset-add')!;
    add.value = '2,75';
    add.dispatchEvent(new Event('change'));
    add.dispatchEvent(new Event('blur')); // leaving the field after Enter: no second save
    expect(save).toHaveBeenLastCalledWith({ presets: [1, 2, 2.75, 4] });
    expect(save).toHaveBeenCalledTimes(2);
    expect(draw({ presets: [1.5] }).card('Preset speeds').querySelector('.chip-x')).toBeNull();
  });

  it('the speed line shows the presets as dots, 1×, and ★ at your speed', () => {
    const { host } = draw({ presets: [1, 1.5, 2], preferred: 1.75 });
    const marks = [...host.querySelectorAll<HTMLElement>('.km-ruler .km-mark')];
    expect(marks.map((m) => m.title)).toEqual(['1×', '1.5×', '2×']);
    expect(marks.every((m) => m.classList.contains('is-preset'))).toBe(true);
    const left = (el: HTMLElement) => parseFloat(el.style.left);
    const star = host.querySelector<HTMLElement>('.km-ruler .km-star')!;
    expect(star.title).toBe('Your speed: 1.75×');
    expect(left(star)).toBeGreaterThan(left(marks[1]!)); // between 1.5× and 2×
    expect(left(star)).toBeLessThan(left(marks[2]!));
    // 1× is on the line even when it is not a preset.
    const without = draw({ presets: [1.5, 2] }).host.querySelectorAll('.km-ruler .km-mark.is-one:not(.is-preset)');
    expect(without.length).toBe(1);
  });

  it('a key is changed by clicking it and pressing the new one', () => {
    const { card, save } = draw();
    const g = card('Your speed').querySelector<HTMLButtonElement>('.key-button')!;
    g.click();
    expect(g.textContent).toBe('Press a key…'); // what holds the page's redraws meanwhile (main.ts)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true }));
    expect(save).toHaveBeenCalledWith({ keys: { ...DEFAULT_MEDIA_SPEED.keys, preferred: 'h' } });
  });
});
