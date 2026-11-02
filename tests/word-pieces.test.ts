import { describe, expect, it } from 'vitest';
import { wordPieces } from '@/shared/word-pieces';
import { splitWords } from '@/engine/g2p/word-timing';
import { spokenToSource } from '@/highlight/word-map';

describe('the words of a text', () => {
  it('splits at spaces, as before, for languages that use them', () => {
    expect(wordPieces('Hello, world. Again!').map((p) => p.token)).toEqual(['Hello,', 'world.', 'Again!']);
    expect(wordPieces('  two  words ').map((p) => p.at)).toEqual([2, 7]);
  });

  it('splits a Chinese sentence into words, not one block (#7)', () => {
    const text = '该域名仅用于文档示例，无需获得许可。';
    const pieces = wordPieces(text);
    expect(pieces.length).toBeGreaterThan(4);
    // Every character is in exactly one piece, in order, with nothing lost.
    expect(pieces.map((p) => p.token).join('')).toBe(text);
    for (const p of pieces) expect(text.slice(p.at, p.at + p.token.length)).toBe(p.token);
    // Punctuation stays with the word before it.
    expect(pieces.some((p) => p.token.length > 1 && p.token.endsWith('，'))).toBe(true);
    expect(pieces.at(-1)!.token.endsWith('。')).toBe(true);
  });

  it('splits Japanese too, and leaves Latin words inside it alone', () => {
    const pieces = wordPieces('これは Aloud のサンプルです。');
    expect(pieces.map((p) => p.token)).toContain('Aloud');
    expect(pieces.length).toBeGreaterThan(3);
  });

  it('word timing and the page highlight see the same Chinese words', () => {
    const text = '无需获得许可。';
    const timed = splitWords(text).map((w) => text.slice(w.from, w.to));
    expect(timed.length).toBeGreaterThan(1);
    // Each timed word maps back onto itself on the page.
    const map = spokenToSource(text, text);
    for (const w of splitWords(text)) expect(map(w.from, w.to)).toEqual([w.from, w.to]);
  });
});
