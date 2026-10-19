import { describe, it, expect } from 'vitest';
import { MAX_POOL, autoPoolSize, clampPool, piperPoolForRate, poolSizeForProvider } from '@/synth-host/pool-size';
import { backendOf, tuningFor } from '@/content/engine-tuning';

const desktop = { cores: 8, touchFirst: false };
const phone = { cores: 8, touchFirst: true };

describe('autoPoolSize', () => {
  it('runs one worker when a GPU is really there', () => {
    expect(autoPoolSize('kokoro', true, desktop)).toBe(1);
    expect(autoPoolSize('supertonic', true, desktop)).toBe(1);
  });

  it('pools the neural engines when there is no GPU — the Chromium-without-an-adapter case', () => {
    expect(autoPoolSize('kokoro', false, desktop)).toBeGreaterThan(1);
    expect(autoPoolSize('supertonic', false, desktop)).toBeGreaterThan(1);
  });

  it('never pools Piper, which is already faster than real time', () => {
    expect(autoPoolSize('piper', false, desktop)).toBe(1);
    expect(autoPoolSize('piper', true, desktop)).toBe(1);
  });

  it('never pools on a phone, whatever the core count says', () => {
    expect(autoPoolSize('kokoro', false, phone)).toBe(1);
  });

  it('keeps Kokoro pooled even on a dual-core machine, and bounded on a big one', () => {
    expect(autoPoolSize('kokoro', false, { cores: 2, touchFirst: false })).toBe(2);
    expect(autoPoolSize('kokoro', false, { cores: 32, touchFirst: false })).toBe(4);
  });
});

describe('clampPool', () => {
  it('honours a pinned worker count within the supported range', () => {
    expect(clampPool(3)).toBe(3);
    expect(clampPool(0)).toBe(1);
    expect(clampPool(99)).toBe(MAX_POOL);
  });
});

describe('poolSizeForProvider', () => {
  it('grows the pool when the worker reports it ended up on the CPU', () => {
    expect(poolSizeForProvider('kokoro', 'wasm', desktop)).toBeGreaterThan(1);
  });

  it('collapses to one worker when the worker reports WebGPU', () => {
    expect(poolSizeForProvider('kokoro', 'webgpu/q8', desktop)).toBe(1);
  });

});

describe('backendOf', () => {
  it('classifies the provider strings the worker actually reports', () => {
    expect(backendOf('wasm')).toBe('cpu');
    expect(backendOf('webgpu/fp32')).toBe('gpu');
    expect(backendOf('webgpu/fp16')).toBe('gpu');
    expect(backendOf(undefined)).toBe('cpu');
  });
});

describe('tuningFor', () => {
  it('runs a deep queue on the CPU and a shallow one on the GPU', () => {
    const cpu = tuningFor('kokoro', 'cpu');
    const gpu = tuningFor('kokoro', 'gpu');
    expect(cpu.lookahead).toBeGreaterThan(gpu.lookahead);
    expect(cpu.primeSeconds).toBeGreaterThan(gpu.primeSeconds);
  });

  it('assumes the CPU until the engine says otherwise', () => {
    expect(tuningFor('kokoro')).toEqual(tuningFor('kokoro', 'cpu'));
  });
});

describe('piperPoolForRate', () => {
  const desktop = { cores: 8, touchFirst: false };
  it('one worker while the voice keeps up', () => {
    expect(piperPoolForRate(0.4, desktop)).toBe(1);
    expect(piperPoolForRate(0.8, desktop)).toBe(1);
  });
  it('enough to bring a slow voice under real time (Lessac at 2.7×: four)', () => {
    expect(piperPoolForRate(1.2, desktop)).toBe(2);
    expect(piperPoolForRate(2.7, desktop)).toBe(4);
    expect(piperPoolForRate(9, desktop)).toBe(4);
  });
  it('never more than the cores allow, never on a phone', () => {
    expect(piperPoolForRate(2.7, { cores: 4, touchFirst: false })).toBe(2);
    expect(piperPoolForRate(2.7, { cores: 8, touchFirst: true })).toBe(1);
  });
});
