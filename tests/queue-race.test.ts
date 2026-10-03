import { expect, it, vi } from 'vitest';

// A storage item whose next read can be held open, to stop a write half-way.
const state = vi.hoisted(() => ({
  value: [] as Array<{ id: string; title: string; url: string; site: string; addedAt: number }>,
  pauseNextRead: false,
  resume: null as null | (() => void),
  paused: null as null | (() => void),
}));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: vi.fn(async () => undefined) } } }));
vi.mock('wxt/utils/storage', () => ({
  storage: {
    defineItem: () => ({
      async getValue() {
        const snapshot = structuredClone(state.value);
        if (state.pauseNextRead) {
          state.pauseNextRead = false;
          await new Promise<void>((r) => {
            state.resume = r;
            state.paused?.();
          });
        }
        return snapshot;
      },
      async setValue(value: typeof state.value) {
        state.value = structuredClone(value);
      },
      watch: () => () => {},
    }),
  },
}));

import { addToQueue, moveInQueue } from '@/shared/reading-queue';

it('an article added while the queue is being reordered is kept', async () => {
  state.value = ['a', 'b'].map((id) => ({ id, url: `https://example.test/${id}`, title: id, site: 'example.test', addedAt: 1 }));
  const paused = new Promise<void>((r) => (state.paused = r));
  state.pauseNextRead = true;
  const moving = moveInQueue('b', -1); // reads [a, b], then stalls before writing
  await paused;
  const adding = addToQueue({ url: 'https://example.test/c', title: 'c', site: 'example.test' });
  state.resume!();
  await moving;
  const added = await adding;
  expect(added.added).toBe(true);
  // Before the fix the move wrote back its stale [b, a] after C was added: C was gone.
  expect(state.value.map((q) => q.title).sort()).toEqual(['a', 'b', 'c']);
  expect(state.value.map((q) => q.title).slice(0, 2)).toEqual(['b', 'a']);
});
