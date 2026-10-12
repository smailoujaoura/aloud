// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { SmoothScroller, scrollDuration } from '@/highlight/smooth-scroll';

describe('following the reading without lurching', () => {
  it('takes longer for a longer move, within bounds', () => {
    expect(scrollDuration(20)).toBeGreaterThanOrEqual(320);
    expect(scrollDuration(400)).toBeGreaterThan(scrollDuration(40));
    expect(scrollDuration(5000)).toBe(760);
  });

  it('jumps when reduced motion is asked for', () => {
    const calls: number[] = [];
    const view = { ...window, scrollY: 100, scrollX: 0, innerHeight: 500, document, scrollTo: (_x: number, y: number) => calls.push(y), addEventListener() {}, removeEventListener() {} } as unknown as Window;
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 5000, configurable: true });
    const s = new SmoothScroller(view, true);
    s.by(null, 300);
    expect(calls).toEqual([400]);
    expect(s.moving).toBe(false);
  });

  it('stops where it is when the reader takes the wheel', () => {
    const listeners = new Map<string, () => void>();
    let frames = 0;
    const view = {
      scrollY: 0, scrollX: 0, innerHeight: 500, document,
      scrollTo() {},
      requestAnimationFrame: () => ++frames,
      cancelAnimationFrame() {},
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener() {},
    } as unknown as Window;
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 5000, configurable: true });
    const s = new SmoothScroller(view, false);
    s.by(null, 800);
    expect(s.moving).toBe(true);
    listeners.get('wheel')!();
    expect(s.moving).toBe(false);
  });
});
