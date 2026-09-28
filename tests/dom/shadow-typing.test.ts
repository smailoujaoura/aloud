// @vitest-environment happy-dom
/**
 * The audit's A12: pressing `d` in an input inside a shadow root changed the video's speed and
 * left the box empty. Confirmed in Chromium at the time; this is the same shape as a unit.
 */
import { describe, expect, it } from 'vitest';
import { MediaSpeedController } from '@/media-speed/controller';
import { isTypingEvent } from '@/media-speed/keys';
import { DEFAULT_MEDIA_SPEED } from '@/shared/settings';

function shadowInput(): { host: HTMLElement; input: HTMLInputElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const input = document.createElement('input');
  root.append(input);
  return { host, input };
}

describe('keys typed inside a shadow root', () => {
  it('are seen as typing', () => {
    const { input } = shadowInput();
    const event = new KeyboardEvent('keydown', { key: 'd', bubbles: true, composed: true });
    input.dispatchEvent(event);
    expect(isTypingEvent(event)).toBe(true);
  });

  it('do not change the video speed', () => {
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    const controller = new MediaSpeedController({
      settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
      initialRate: null,
      onRate: () => {},
    });
    controller.start();
    const { input } = shadowInput();
    const event = new KeyboardEvent('keydown', { key: 'd', bubbles: true, composed: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(video.playbackRate).toBe(1);
    controller.stop();
  });

  it('still lets the shortcut work outside a text box', () => {
    document.body.innerHTML = '<video id="v"></video><p id="text">words</p>';
    const video = document.getElementById('v') as HTMLVideoElement;
    const controller = new MediaSpeedController({
      settings: { ...DEFAULT_MEDIA_SPEED, showBadge: false },
      initialRate: null,
      onRate: () => {},
    });
    controller.start();
    document.getElementById('text')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, composed: true, cancelable: true }));
    expect(video.playbackRate).toBeGreaterThan(1);
    controller.stop();
  });
});
