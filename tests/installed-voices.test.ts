/**
 * The audit's A13: a cache holding a model's config, and none of its weights, offered every
 * voice of that engine as ready to read.
 */
import { describe, expect, it } from 'vitest';
import { sharedModelInstalled, usableVoices } from '@/engine/installed-voices';
import type { CacheSizes } from '@/engine/installed-voices';
import type { ModelManifest } from '@/engine/engines/types';
import { KOKORO_REVISION, SUPERTONIC_REVISION } from '@/shared/engine-catalog';

const manifest = {
  piper: {},
  kokoro: { voices: { af_heart: { label: 'Heart', gender: 'female', language: 'en-US' } } },
  supertonic: { voices: { F1: { label: 'Female 1', gender: 'female' } } },
} as unknown as ModelManifest;

const cache = (entries: Record<string, number>): CacheSizes => new Map(Object.entries(entries));

// Where the loaders fetch from: the models at their pinned commits, Kokoro's voices from main
// (kokoro-js fetches those itself). Files from anywhere else are not the ones the loader asks for.
const KOKORO = `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${KOKORO_REVISION}`;
const KOKORO_VOICES = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
const SUPERTONIC = `https://huggingface.co/Supertone/supertonic-3/resolve/${SUPERTONIC_REVISION}`;

describe('what counts as installed', () => {
  it('does not accept Kokoro’s config as Kokoro', () => {
    const sizes = cache({ [`${KOKORO}/config.json`]: 400, [`${KOKORO}/tokenizer.json`]: 900 });
    expect(sharedModelInstalled('kokoro', sizes)).toBe(false);
    expect(usableVoices('kokoro', manifest, sizes)).toEqual([]);
  });

  it('accepts Kokoro once its weights are there', () => {
    const sizes = cache({
      [`${KOKORO}/config.json`]: 400,
      [`${KOKORO}/tokenizer.json`]: 900,
      [`${KOKORO}/tokenizer_config.json`]: 90,
      [`${KOKORO}/onnx/model_quantized.onnx`]: 86_000_000,
    });
    expect(sharedModelInstalled('kokoro', sizes)).toBe(true);
    expect(usableVoices('kokoro', manifest, sizes)).toHaveLength(1);
  });

  it('needs every one of Supertonic’s four networks', () => {
    const three = cache({
      [`${SUPERTONIC}/onnx/tts.json`]: 1,
      [`${SUPERTONIC}/onnx/unicode_indexer.json`]: 1,
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

describe('the recheck’s R09: what a voice needs to start', () => {
  const kokoroBase = {
    [`${KOKORO}/config.json`]: 1,
    [`${KOKORO}/tokenizer.json`]: 1,
    [`${KOKORO}/tokenizer_config.json`]: 1,
  };

  it('accepts Kokoro’s GPU weights alone, on a machine that runs it on the GPU', () => {
    const sizes = cache({ ...kokoroBase, [`${KOKORO}/onnx/model.onnx`]: 300_000_000 });
    expect(sharedModelInstalled('kokoro', sizes, { gpu: true })).toBe(true);
    expect(sharedModelInstalled('kokoro', sizes, { gpu: null })).toBe(true);
    // …but not where it runs on the CPU, which loads the quantised weights instead.
    expect(sharedModelInstalled('kokoro', sizes, { gpu: false })).toBe(false);
  });

  it('needs Kokoro’s tokeniser as well as its weights', () => {
    const sizes = cache({ [`${KOKORO}/onnx/model_quantized.onnx`]: 86_000_000 });
    expect(sharedModelInstalled('kokoro', sizes)).toBe(false);
  });

  it('offline, offers only the voices whose own file was fetched', () => {
    const many = {
      ...manifest,
      kokoro: { voices: { af_heart: { label: 'Heart' }, bm_george: { label: 'George' } } },
    } as unknown as ModelManifest;
    const sizes = cache({ ...kokoroBase, [`${KOKORO}/onnx/model_quantized.onnx`]: 1, [`${KOKORO_VOICES}/voices/af_heart.bin`]: 1 });
    expect(usableVoices('kokoro', many, sizes, { online: false }).map((v) => v.id)).toEqual(['af_heart']);
    // Online, a voice file is a small download: every voice of the installed model is offered.
    expect(usableVoices('kokoro', many, sizes, { online: true })).toHaveLength(2);
  });

  it('needs Supertonic’s config, character table and the voice’s style', () => {
    const nets = {
      [`${SUPERTONIC}/onnx/text_encoder.onnx`]: 1,
      [`${SUPERTONIC}/onnx/duration_predictor.onnx`]: 1,
      [`${SUPERTONIC}/onnx/vector_estimator.onnx`]: 1,
      [`${SUPERTONIC}/onnx/vocoder.onnx`]: 1,
    };
    expect(sharedModelInstalled('supertonic', cache(nets))).toBe(false);
    const full = cache({ ...nets, [`${SUPERTONIC}/onnx/tts.json`]: 1, [`${SUPERTONIC}/onnx/unicode_indexer.json`]: 1 });
    expect(sharedModelInstalled('supertonic', full)).toBe(true);
    expect(usableVoices('supertonic', manifest, full, { online: false })).toEqual([]);
    full.set(`${SUPERTONIC}/voice_styles/F1.json`, 1);
    expect(usableVoices('supertonic', manifest, full, { online: false }).map((v) => v.id)).toEqual(['F1@en']);
  });
});

describe('the second recheck’s V06: which weights reading will use', async () => {
  const { readingOnGpu } = await import('@/engine/installed-voices');
  const KOKORO_CPU = cache({
    [`${KOKORO}/config.json`]: 1,
    [`${KOKORO}/tokenizer.json`]: 1,
    [`${KOKORO}/tokenizer_config.json`]: 1,
    [`${KOKORO}/onnx/model_quantized.onnx`]: 1,
    [`${KOKORO_VOICES}/voices/af_heart.bin`]: 1,
  });

  it('a machine with a GPU, set to read on the CPU, keeps its CPU voices offline', () => {
    const gpu = readingOnGpu(false, true);
    expect(gpu).toBe(false);
    expect(usableVoices('kokoro', manifest, KOKORO_CPU, { gpu, online: false }).map((v) => v.id)).toEqual(['af_heart']);
  });

  it('set to use the GPU, and with one, needs the GPU weights', () => {
    expect(readingOnGpu(true, true)).toBe(true);
    expect(usableVoices('kokoro', manifest, KOKORO_CPU, { gpu: true, online: false })).toEqual([]);
  });

  it('set to use the GPU, without one, reads on the CPU', () => {
    expect(readingOnGpu(true, false)).toBe(false);
    expect(readingOnGpu(undefined, null)).toBeNull();
  });
});
