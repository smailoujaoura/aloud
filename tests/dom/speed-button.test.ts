// @vitest-environment happy-dom
/**
 * The speed button on a computer: shown as a player shows its own controls, by the mouse moving
 * over the video, held up while the mouse is on it, kept off the reading bar, and gone the moment
 * Settings turns it off. Its clicks stay its own; a click on the video is still the page's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaSpeedController } from '@/media-speed/controller';
import { DEFAULT_MEDIA_SPEED, type MediaSpeedSettings } from '@/shared/settings';

/** The button's shadow roots are closed: kept here as they are made, to reach its buttons. */
const roots = new Map<Element, ShadowRoot>();
const attach = HTMLElement.prototype.attachShadow;

/** A video on screen, from (50, 40), 640 by 360 unless said otherwise. */
function video(width = 640, height = 360): HTMLVideoElement {
  const el = document.createElement('video');
  const box = { left: 50, top: 40, width, height, right: 50 + width, bottom: 40 + height, x: 50, y: 40 };
  el.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
  document.body.append(el);
  return el;
}

function start(over: Partial<MediaSpeedSettings> = {}, touchButton = false) {
  const controller = new MediaSpeedController({
    settings: { ...DEFAULT_MEDIA_SPEED, ...over },
    initialRate: null,
    onRate: () => undefined,
    touchButton,
  });
  controller.start();
  return controller;
}

const button = (): HTMLElement | null => document.getElementById('aloud-speed-touch');
const shown = (): boolean => button()?.style.display === 'block';
const part = (selector: string): HTMLElement => roots.get(button()!)!.querySelector<HTMLElement>(selector)!;

function pointer(type: string, at: EventTarget, init: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, pointerType: 'mouse', isPrimary: true, ...init });
  at.dispatchEvent(e);
  return e;
}
const mouseOver = (el: Element, x = 200, y = 200): PointerEvent => pointer('pointermove', el, { clientX: x, clientY: y });

describe('the speed button on a computer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    document.body.replaceChildren();
    roots.clear();
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init: ShadowRootInit) {
      const root = attach.call(this, init);
      roots.set(this, root);
      return root;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.getElementById('aloud-control-host')?.remove();
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it('shows when the mouse moves over the video, and fades after a few seconds of stillness', () => {
    const el = video();
    const controller = start();
    expect(button()).toBeNull();
    mouseOver(el);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(3100);
    expect(shown()).toBe(false);
    controller.stop();
  });

  it('stays up while the mouse keeps moving over the video, looked at a few times a second', () => {
    const el = video();
    const controller = start();
    mouseOver(el);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(2500);
      mouseOver(el, 210 + i, 200);
      expect(shown()).toBe(true);
    }
    vi.advanceTimersByTime(3100);
    expect(shown()).toBe(false);
    // The first move shows it at once.
    mouseOver(el, 300, 200);
    expect(shown()).toBe(true);
    // Closed by a click elsewhere, then moves inside the throttle: the last is still looked at.
    pointer('pointerdown', document.body, { clientX: 900, clientY: 600 });
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(50);
    mouseOver(el, 301, 200);
    mouseOver(el, 302, 200);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(200);
    expect(shown()).toBe(true);
    controller.stop();
  });

  it('not for the mouse elsewhere on the page, nor a finger, nor a player too small to cover', () => {
    const el = video();
    const controller = start();
    mouseOver(document.body, 900, 600);
    pointer('pointermove', el, { clientX: 200, clientY: 200, pointerType: 'touch' });
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(false);
    controller.stop();

    document.body.replaceChildren();
    const small = video(150, 80);
    const again = start();
    mouseOver(small, 100, 60);
    vi.advanceTimersByTime(300);
    expect(shown()).toBe(false);
    again.stop();
  });

  it('is held up while the mouse is on it, and fades once it leaves', () => {
    const el = video();
    const controller = start();
    mouseOver(el);
    const pill = part('.pill');
    pointer('pointerenter', pill, { bubbles: false });
    vi.advanceTimersByTime(20_000);
    expect(shown()).toBe(true);
    // Clicked, opened and stepped while the mouse is still on it: still no fading.
    part('.value').click();
    part('.step').click();
    vi.advanceTimersByTime(20_000);
    expect(shown()).toBe(true);
    pointer('pointerleave', pill, { bubbles: false });
    // Opened, it stays a little longer than the closed chip does.
    vi.advanceTimersByTime(4000);
    expect(shown()).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(shown()).toBe(false);
    controller.stop();
  });

  it('a click on the video still reaches the page; one on the button does not, nor takes the focus', () => {
    const el = video();
    const controller = start();
    const page = vi.fn();
    document.addEventListener('click', page);
    document.addEventListener('pointerdown', page);
    pointer('pointerdown', el, { clientX: 200, clientY: 200 });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(page).toHaveBeenCalledTimes(2);
    expect(shown()).toBe(true);

    page.mockClear();
    const value = part('.value');
    const press = new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true });
    value.dispatchEvent(press);
    // Left with the focus, the page's Space and Enter would press it again.
    expect(press.defaultPrevented).toBe(true);
    value.click();
    expect(page).not.toHaveBeenCalled();
    expect(part('.pill').classList.contains('open')).toBe(true);
    document.removeEventListener('click', page);
    document.removeEventListener('pointerdown', page);
    controller.stop();
  });

  it('turned off in Settings, it goes at once, and comes back when turned on', () => {
    const el = video();
    const controller = start();
    mouseOver(el);
    expect(shown()).toBe(true);
    controller.setSettings({ ...DEFAULT_MEDIA_SPEED, showButton: false });
    expect(button()).toBeNull();
    vi.advanceTimersByTime(300);
    mouseOver(el);
    expect(button()).toBeNull();
    controller.setSettings({ ...DEFAULT_MEDIA_SPEED, showButton: true });
    vi.advanceTimersByTime(300);
    mouseOver(el);
    expect(shown()).toBe(true);
    controller.stop();
    expect(button()).toBeNull();
    // A stopped control is still told of settings: it must not put the button back.
    controller.setSettings({ ...DEFAULT_MEDIA_SPEED, showButton: true });
    vi.advanceTimersByTime(300);
    mouseOver(el);
    expect(button()).toBeNull();
  });

  it('a phone keeps its button whatever the setting says', () => {
    const el = video();
    const controller = start({ showButton: false }, true);
    pointer('pointerdown', el, { clientX: 200, clientY: 200, pointerType: 'touch' });
    expect(shown()).toBe(true);
    controller.stop();
  });

  it('is kept off the reading bar', () => {
    const el = video();
    const bar = document.createElement('div');
    bar.id = 'aloud-control-host';
    document.documentElement.append(bar);
    // The bar across the top of the window, down to y = 120 (wherever the viewer dragged it).
    document.elementsFromPoint = (_x: number, y: number) => (y < 120 ? [bar] : []);
    const controller = start();
    mouseOver(el);
    expect(shown()).toBe(true);
    const top = parseFloat(button()!.style.top);
    expect(top).toBeGreaterThanOrEqual(120 + 6);
    // Just clear of it, not sent to the far side of the video.
    expect(top).toBeLessThan(120 + 6 + 12 + 1);

    // Nowhere on the video clear: not shown at all.
    document.elementsFromPoint = () => [bar];
    vi.advanceTimersByTime(3100);
    mouseOver(el, 220, 200);
    expect(shown()).toBe(false);
    controller.stop();
  });
});
