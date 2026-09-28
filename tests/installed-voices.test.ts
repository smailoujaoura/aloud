/**
 * The audit's A13: a cache holding a model's config, and none of its weights, offered every
 * voice of that engine as ready to read.
 */
import { describe, expect, it } from 'vitest';
import { sharedModelInstalled, usableVoices } from '@/engine/installed-voices';
import type { CacheSizes } from '@/engine/installed-voices';
import type { ModelManifest } from '@/engine/engines/types';

const manifest = {
  piper: {},
  kokoro: { voices: { af_heart: { label: 'Heart', gender: 'female', language: 'en-US' } } },
  supertonic: { voices: { F1: { label: 'Female 1', gender: 'female' } } },
} as unknown as ModelManifest;

const cache = (entries: Record<string, number>): CacheSizes => new Map(Object.entries(entries));

const KOKORO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
const SUPERTONIC = 'https://huggingface.co/Supertone/supertonic-2/resolve/main';

describe('what counts as installed', () => {
  it('does not accept Kokoro’s config as Kokoro', () => {
    const sizes = cache({ [`${KOKORO}/config.json`]: 400, [`${KOKORO}/tokenizer.json`]: 900 });
    expect(sharedModelInstalled('kokoro', sizes)).toBe(false);
    expect(usableVoices('kokoro', manifest, sizes)).toEqual([]);
  });

  it('accepts Kokoro once its weights are there', () => {
    const sizes = cache({ [`${KOKORO}/config.json`]: 400, [`${KOKORO}/onnx/model_quantized.onnx`]: 86_000_000 });
    expect(sharedModelInstalled('kokoro', sizes)).toBe(true);
    expect(usableVoices('kokoro', manifest, sizes)).toHaveLength(1);
  });

  it('needs every one of Supertonic’s four networks', () => {
    const three = cache({
      [`${SUPERTONIC}/onnx/text_encoder.onnx`]: 1,
      [`${SUPERTONIC}/onnx/duration_predictor.onnx`]: 1,
      [`${SUPERTONIC}/onnx/vector_estimator.onnx`]: 1,
    });
    expect(sharedModelInstalled('supertonic', three)).toBe(false);
    three.set(`${SUPERTONIC}/onnx/vocoder.onnx`, 1);
    expect(sharedModelInstalled('supertonic', three)).toBe(true);
  });

  it('ignores a file that is in the cache with nothing in it', () => {
    const sizes = cache({ [`${KOKORO}/onnx/model_quantized.onnx`]: 0 });
    expect(sharedModelInstalled('kokoro', sizes)).toBe(false);
  });
});
