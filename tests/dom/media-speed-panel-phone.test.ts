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

describe('video speed settings on a computer: each key in a tile with what it uses (#12)', () => {
  const draw = (over: Partial<typeof DEFAULT_MEDIA_SPEED> = {}) => {
    env.touchFirst = false;
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const save = vi.fn(async () => {});
    renderMediaSpeedPanel(host, { settings: { ...DEFAULT_MEDIA_SPEED, ...over }, save, toast: vi.fn() });
    const tile = (act: string) => host.querySelector<HTMLElement>(`.km-tile[data-act="${act}"]`)!;
    return { host, save, tile };
  };
  const keysIn = (tile: HTMLElement) => [...tile.querySelectorAll('.key-button')].map((b) => b.textContent);
  const press = (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true }));

  it('each tile holds its keys and the value they use: G with Your speed, S and D with the step', () => {
    const { tile } = draw({ preferred: 1.5 });
    expect(keysIn(tile('your-speed'))).toEqual(['G']);
    expect(tile('your-speed').querySelector<HTMLSelectElement>('select')!.value).toBe('1.5');
    expect(keysIn(tile('step'))).toEqual(['S', 'D']);
    expect(tile('step').querySelector<HTMLSelectElement>('select')!.value).toBe('0.25');
    expect(keysIn(tile('presets'))).toEqual(['⇧ S', '⇧ D']);
    expect(tile('presets').querySelector('.key-button')!.getAttribute('aria-label')).toBe('Previous preset key: Shift + S');
    expect(keysIn(tile('seek'))).toEqual(['Z', 'X']);
    expect(keysIn(tile('mute'))).toEqual(['M']);
    expect(tile('mute').querySelector('svg.km-icon')).not.toBeNull();
  });

  it('Your speed can be 1.75×, and at 1× says G does nothing', () => {
    const { tile, save } = draw({ preferred: 1 });
    const picker = tile('your-speed').querySelector<HTMLSelectElement>('select')!;
    expect([...picker.options].map((o) => o.value)).toContain('1.75');
    expect(tile('your-speed').textContent).toContain('Does nothing at 1×');
    picker.value = '1.75';
    picker.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenCalledWith({ preferred: 1.75 });
    expect(draw({ preferred: 1.75 }).tile('your-speed').textContent).not.toContain('Does nothing');
  });

  it('the line shows the presets as dots, 1×, and ★ at your speed', () => {
    const { host } = draw({ presets: [1, 1.5, 2], preferred: 1.75 });
    const marks = [...host.querySelectorAll<HTMLElement>('.km-ruler .km-mark:not(.km-ghost)')];
    expect(marks.map((m) => m.querySelector('b')!.textContent)).toEqual(['1×', '1.5×', '2×']);
    expect(marks.every((m) => m.classList.contains('is-preset'))).toBe(true);
    const left = (el: HTMLElement) => parseFloat(el.style.left);
    const star = host.querySelector<HTMLElement>('.km-ruler .km-star')!;
    expect(star.title).toBe('Your speed: 1.75×');
    expect(left(star)).toBeGreaterThan(left(marks[1]!)); // between 1.5× and 2×
    expect(left(star)).toBeLessThan(left(marks[2]!));
    // 1× is on the line even when it is not a preset, and cannot be clicked away.
    const one = draw({ presets: [1.5, 2] }).host.querySelector('.km-ruler .km-mark.is-one')!;
    expect(one.tagName).toBe('SPAN');
  });

  it('the line sets the presets: a dot clicked goes, the line clicked adds the speed there, "+" a typed one', () => {
    const { host, save } = draw({ presets: [1, 2, 4], preferred: 1.5 });
    host.querySelector<HTMLButtonElement>('[aria-label="Remove 4× from the presets"]')!.click();
    expect(save).toHaveBeenLastCalledWith({ presets: [1, 2] });
    // The line from 0.25× to 4× is 400 px: 1.75× is 70% along, on the doubling scale.
    const hit = host.querySelector<HTMLElement>('.km-hit')!;
    hit.getBoundingClientRect = () => new DOMRect(0, 0, 400, 32);
    hit.dispatchEvent(new MouseEvent('click', { clientX: 281, bubbles: true }));
    expect(save).toHaveBeenLastCalledWith({ presets: [1, 1.75, 2, 4] });
    const add = host.querySelector<HTMLInputElement>('.km-ruler .preset-add')!;
    add.value = '2,5x';
    add.dispatchEvent(new Event('change'));
    add.dispatchEvent(new Event('blur')); // leaving the field after Enter: no second save
    expect(save).toHaveBeenLastCalledWith({ presets: [1, 2, 2.5, 4] });
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('the last preset stays', () => {
    const { host, save } = draw({ presets: [1.5] });
    const dot = host.querySelector<HTMLButtonElement>('[aria-label="Remove 1.5× from the presets"]')!;
    expect(dot.disabled).toBe(true);
    dot.click();
    expect(save).not.toHaveBeenCalled();
  });

  it('a key is changed by clicking it and pressing the new one; the cap keeps its size, the tile asks', () => {
    const { tile, save } = draw();
    const g = tile('your-speed').querySelector<HTMLButtonElement>('.key-button')!;
    g.click();
    expect(g.textContent).toBe('G'); // the same cap, waiting: nothing spills over the tile
    expect(g.hasAttribute('data-recording')).toBe(true); // what holds the page's redraws (main.ts)
    expect(tile('your-speed').classList.contains('is-recording')).toBe(true);
    press('h');
    expect(save).toHaveBeenCalledWith({ keys: { ...DEFAULT_MEDIA_SPEED.keys, preferred: 'h' } });
    expect(g.hasAttribute('data-recording')).toBe(false);
  });

  it('one key waits at a time: another clicked stops the first, which keeps its key', () => {
    const { tile, save } = draw();
    const [s, d] = [...tile('step').querySelectorAll<HTMLButtonElement>('.key-button')];
    s!.click();
    d!.click();
    expect(s!.hasAttribute('data-recording')).toBe(false);
    expect(s!.textContent).toBe('S');
    press('k');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ keys: { ...DEFAULT_MEDIA_SPEED.keys, faster: 'k' } });
  });

  it('a click elsewhere, or the same key again, stops the wait unchanged', () => {
    const { host, tile, save } = draw();
    const m = tile('mute').querySelector<HTMLButtonElement>('.key-button')!;
    m.click();
    host.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(m.hasAttribute('data-recording')).toBe(false);
    m.click();
    m.click();
    expect(m.hasAttribute('data-recording')).toBe(false);
    press('q');
    expect(save).not.toHaveBeenCalled();
  });
});
