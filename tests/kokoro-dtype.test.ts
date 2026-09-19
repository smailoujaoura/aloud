import { describe, expect, it } from 'vitest';
import { dtypeFor } from '@/engine/engines/kokoro';

/**
 * Not a preference: the quantised build returns audio on WebGPU, but the audio is Mandarin-ish
 * noise instead of speech (verified by transcribing it). Full precision is the only build that
 * speaks there; the CPU is the other way round.
 */
describe('Kokoro weights per device', () => {
  it('pairs each device with the build that actually speaks', () => {
    expect(dtypeFor('webgpu')).toBe('fp32');
    expect(dtypeFor('wasm')).toBe('q8');
  });
});
