import { describe, expect, it, vi } from 'vitest';
import { GaplessScheduler } from '@/audio/scheduler';

/** The scheduler's private state, as these tests need to see it. */
type Inner = {
  nextToSchedule: number;
  lastEnded: number;
  pendingPcm: Map<number, unknown>;
  sources: Map<number, { stop(): void; disconnect(): void; onended: unknown }>;
};

function scheduler() {
  const need = vi.fn();
  const s = new GaplessScheduler({
    onChunkStart: vi.fn(),
    onChunkEnd: vi.fn(),
    onNeedMore: need,
    onUnderrun: vi.fn(),
    onFinished: vi.fn(),
  });
  return { s, inner: s as unknown as Inner, need };
}

describe('changing speed', () => {
  it('before the first Play: the first sentence is made again, not skipped', () => {
    const { s, inner, need } = scheduler();
    s.provide(0, new Float32Array([0.1]), 22050); // made at the old speed, not playing yet
    s.reprimeForSpeed();
    expect(inner.nextToSchedule).toBe(0);
    expect(need).toHaveBeenLastCalledWith(0);
    // The remade sentence zero is accepted, not thrown away as already past.
    s.provide(0, new Float32Array([0.2]), 22050);
    expect(inner.pendingPcm.has(0)).toBe(true);
  });

  it('while a sentence is sounding: that one finishes, the next is remade', () => {
    const { s, inner, need } = scheduler();
    const stop = vi.fn();
    inner.sources.set(0, { stop, disconnect: vi.fn(), onended: null }); // sentence zero is playing
    const later = vi.fn();
    inner.sources.set(1, { stop: later, disconnect: vi.fn(), onended: null }); // already queued after it
    s.reprimeForSpeed();
    expect(stop).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalled();
    expect(inner.nextToSchedule).toBe(1);
    expect(need).toHaveBeenLastCalledWith(1);
  });

  it('between sentences (buffering): resumes at the sentence that has not played', () => {
    const { s, inner, need } = scheduler();
    inner.lastEnded = 2; // sentences 0–2 done, 3 not yet scheduled
    s.reprimeForSpeed();
    expect(inner.nextToSchedule).toBe(3);
    expect(need).toHaveBeenLastCalledWith(3);
  });
});
