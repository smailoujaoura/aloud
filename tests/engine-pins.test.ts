import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { KOKORO_REVISION, SUPERTONIC_REVISION } from '@/shared/engine-catalog';
import { sharedModelInstalled, usableVoices } from '@/engine/installed-voices';
import manifest from '../public/models.json';

const base = JSON.parse(readFileSync('scripts/models.base.json', 'utf8')) as { supertonic: { base: string } };
const files = ['onnx/text_encoder.onnx', 'onnx/duration_predictor.onnx', 'onnx/vector_estimator.onnx', 'onnx/vocoder.onnx', 'onnx/tts.json', 'onnx/unicode_indexer.json', 'voice_styles/F1.json'];
const at = (revision: string) => new Map(files.map((f) => [`https://huggingface.co/Supertone/supertonic-2/resolve/${revision}/${f}`, 1]));
const offline = { gpu: false, online: false };

describe('pinned model revisions', () => {
  it('one pin each: the catalog, the loader and models.json agree', () => {
    expect(base.supertonic.base).toBe(`https://huggingface.co/Supertone/supertonic-2/resolve/${SUPERTONIC_REVISION}`);
    expect((manifest as unknown as typeof base).supertonic.base).toBe(base.supertonic.base);
    expect(readFileSync('src/engine/engines/kokoro.ts', 'utf8')).toContain('KOKORO_REV = KOKORO_REVISION');
    expect(KOKORO_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the seventh recheck (AA02): files cached from main, before the pin, do not count offline', () => {
    expect(sharedModelInstalled('supertonic', at('main'), offline)).toBe(false);
    expect(usableVoices('supertonic', manifest as never, at('main'), offline)).toEqual([]);
  });

  it('files cached from the pinned revision do', () => {
    expect(sharedModelInstalled('supertonic', at(SUPERTONIC_REVISION), offline)).toBe(true);
    expect(usableVoices('supertonic', manifest as never, at(SUPERTONIC_REVISION), offline).map((v) => v.id)).toEqual(['F1']);
  });
});
