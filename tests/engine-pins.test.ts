import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KOKORO_REVISION, SUPERTONIC_REVISION, kokoroVoiceUrl, supertonicStyleUrl } from '@/shared/engine-catalog';
import { sharedModelInstalled, usableVoices } from '@/engine/installed-voices';
import manifest from '../public/models.json';

// Kokoro's model as the CPU reads it, cached from `revision`, with one voice's file.
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const at = (revision: string) =>
  new Map([
    ...files.map((f): [string, number] => [`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${revision}/${f}`, 1]),
    [kokoroVoiceUrl('af_heart'), 1],
  ]);
const offline = { gpu: false, online: false };
const oneVoice = { ...manifest, kokoro: { ...manifest.kokoro, voices: { af_heart: manifest.kokoro.voices.af_heart } } };

describe('pinned model revisions', () => {
  it('one pin each: the catalog, the loader and models.json agree', () => {
    expect(readFileSync('src/engine/engines/kokoro.ts', 'utf8')).toContain('KOKORO_REV = KOKORO_REVISION');
    expect(KOKORO_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the seventh recheck (AA02): files cached from main, before the pin, do not count offline', () => {
    expect(sharedModelInstalled('kokoro', at('main'), offline)).toBe(false);
    expect(usableVoices('kokoro', oneVoice as never, at('main'), offline)).toEqual([]);
  });

  it('files cached from the pinned revision do', () => {
    expect(sharedModelInstalled('kokoro', at(KOKORO_REVISION), offline)).toBe(true);
    expect(usableVoices('kokoro', oneVoice as never, at(KOKORO_REVISION), offline).map((v) => v.id)).toEqual(['af_heart']);
  });
});

const base = JSON.parse(readFileSync('scripts/models.base.json', 'utf8')) as { supertonic: { base: string; languages: string[] } };
const stFiles = ['onnx/text_encoder.onnx', 'onnx/duration_predictor.onnx', 'onnx/vector_estimator.onnx', 'onnx/vocoder.onnx', 'onnx/tts.json', 'onnx/unicode_indexer.json', 'voice_styles/F1.json'];
const stAt = (revision: string) => new Map(stFiles.map((f) => [`https://huggingface.co/Supertone/supertonic-3/resolve/${revision}/${f}`, 1]));

describe('Supertonic 3, pinned', () => {
  it('one pin: the catalog, the style URLs and models.json agree', () => {
    expect(base.supertonic.base).toBe(`https://huggingface.co/Supertone/supertonic-3/resolve/${SUPERTONIC_REVISION}`);
    expect((manifest as unknown as typeof base).supertonic.base).toBe(base.supertonic.base);
    expect(supertonicStyleUrl('F1')).toBe(`${base.supertonic.base}/voice_styles/F1.json`);
    expect(SUPERTONIC_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  it('files cached from main, before the pin, do not count offline', () => {
    expect(sharedModelInstalled('supertonic', stAt('main'), offline)).toBe(false);
    expect(usableVoices('supertonic', manifest as never, stAt('main'), offline)).toEqual([]);
  });

  it('files cached from the pinned revision do: one style, in every one of its 31 languages', () => {
    expect(sharedModelInstalled('supertonic', stAt(SUPERTONIC_REVISION), offline)).toBe(true);
    const ids = usableVoices('supertonic', manifest as never, stAt(SUPERTONIC_REVISION), offline).map((v) => v.id);
    expect(ids).toHaveLength(31);
    expect(ids).toContain('F1@de');
    expect(ids.every((id) => id.startsWith('F1@'))).toBe(true);
  });
});

describe('Kokoro voice files', () => {
  it('every voice offered has a fingerprint, and is downloaded from the pinned revision', async () => {
    const { KOKORO_VOICE_SHA256 } = await import('@/shared/kokoro-voice-pins');
    const { kokoroVoiceSource } = await import('@/engine/kokoro-voice-files');
    for (const voice of Object.keys(manifest.kokoro.voices)) {
      expect(KOKORO_VOICE_SHA256[voice], voice).toMatch(/^[0-9a-f]{64}$/);
      expect(kokoroVoiceSource(voice)).toContain(`/resolve/${KOKORO_REVISION}/voices/${voice}.bin`);
    }
  });
});
