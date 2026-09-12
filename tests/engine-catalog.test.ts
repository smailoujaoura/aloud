import { describe, it, expect } from 'vitest';
import { ENGINE_IDS, engineInfo, listEngines } from '@/shared/engine-catalog';

describe('engineInfo', () => {
  /**
   * The copy used to be written relative to whatever browser was reading it ("slow here",
   * "works here"), which says nothing about the engine and changes under the reader when a GPU
   * probe returns. Whether this machine has acceleration is reported once, in its own section.
   */
  it('describes the engine, never the machine reading it', () => {
    for (const id of ENGINE_IDS) {
      const info = engineInfo(id);
      expect(`${info.tag} — ${info.blurb}`).not.toMatch(
        /\bhere\b|this browser|this device|recommended|firefox|chrom/i,
      );
    }
  });

  it('says plainly which engine only gets fast with a GPU', () => {
    expect(engineInfo('kokoro').needsGpuForSpeed).toBe(true);
    expect(engineInfo('piper').needsGpuForSpeed).toBe(false);
    expect(engineInfo('supertonic').needsGpuForSpeed).toBe(false);
  });

  it('flags the engines that are a bad idea on a phone', () => {
    expect(engineInfo('piper').heavyForMobile).toBe(false);
    expect(engineInfo('kokoro').heavyForMobile).toBe(true);
    expect(engineInfo('supertonic').heavyForMobile).toBe(true);
  });

  it('carries a cache hint only for the shared-model engines', () => {
    expect(engineInfo('piper').cacheHint).toBeUndefined();
    expect(engineInfo('kokoro').cacheHint).toBe('Kokoro-82M');
    expect(engineInfo('supertonic').cacheHint).toBe('supertonic-2');
  });
});

describe('listEngines', () => {
  it('is a fixed order — smallest and most portable first', () => {
    expect(listEngines().map((e) => e.id)).toEqual(['piper', 'kokoro', 'supertonic']);
  });

  it('lists every engine exactly once', () => {
    expect(listEngines()).toHaveLength(ENGINE_IDS.length);
  });
});
