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

describe('retargeting a move under way', () => {
  it('aims at the current position plus the new delta, never the old destination plus it', () => {
    let y = 0;
    let frame = null as ((t: number) => void) | null;
    const view = {
      get scrollY() { return y; }, scrollX: 0, innerHeight: 500, document,
      scrollTo: (_x: number, top: number) => { y = top; },
      requestAnimationFrame: (f: (t: number) => void) => { frame = f; return 1; },
      cancelAnimationFrame() {},
      addEventListener() {}, removeEventListener() {},
    } as unknown as Window;
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 10000, configurable: true });
    const s = new SmoothScroller(view, false);
    s.by(null, 1000); // to 1000
    y = 600; // part-way there; the passage is now 400 px below the line
    s.by(null, 400);
    // Run the animation to its end.
    for (let i = 0; i < 200 && frame; i++) { const f = frame; frame = null; f(performance.now() + 10_000); }
    expect(y).toBe(1000);
  });
});
