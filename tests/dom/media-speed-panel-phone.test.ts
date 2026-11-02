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
    expect(host.textContent).not.toContain('Keys, while a page has a video');
    expect(host.textContent).toContain('one tap of − or +');
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

  it('on a computer: the keys as before, no phone switch', () => {
    env.touchFirst = false;
    const { host } = render();
    expect(host.textContent).toContain('Keys, while a page has a video');
    expect(host.textContent).not.toContain('Show the speed button on every video');
  });
});
