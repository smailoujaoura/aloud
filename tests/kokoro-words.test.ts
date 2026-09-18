import { describe, it, expect, vi } from 'vitest';

// The engine module pulls in the model runtime; only the phonemiser helper is under test.
vi.mock('kokoro-js', () => ({ KokoroTTS: class {} }));
vi.mock('@huggingface/transformers', () => ({ env: {} }));
vi.mock('@/engine/ort-loader', () => ({ loadOrt: async () => ({}) }));
vi.mock('@/engine/runtime-env', () => ({ chooseExecutionProviders: async () => ['wasm'] }));
vi.mock('@/engine/model-cache', () => ({
  TransformersCache: {},
  cacheHas: async () => false,
  fetchModelFile: async () => new Uint8Array(),
  setCachedFileTransform: () => {},
}));

const { phonemizeWords } = await import('@/engine/engines/kokoro');
const { splitWords } = await import('@/engine/g2p/word-timing');

describe('phonemising words for Kokoro word timing', () => {
  it('gets one part per word from a single eSpeak call, punctuation and numbers included', async () => {
    const text = 'In 1990, Dr. Smith — quietly — paid $3.50 for the house.';
    const words = splitWords(text);
    const parts = await phonemizeWords(words, 'en-us');
    expect(parts).not.toBeNull();
    expect(parts).toHaveLength(words.length);
    // A dash on its own has no sounds; every real word has some.
    words.forEach((w, i) => {
      if (/[\p{L}\p{N}]/u.test(w.token)) expect(parts![i]!.length).toBeGreaterThan(0);
      else expect(parts![i]).toBe('');
    });
    expect(parts![words.findIndex((w) => w.token === 'house.')]).toMatch(/hˈ?aʊs/);
  }, 30000);
});
