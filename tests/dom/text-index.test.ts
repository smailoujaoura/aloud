// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextIndex, rangeForSpan } from '@/extract/text-index';

describe('buildTextIndex (happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('flattens visible text with newlines at block boundaries', () => {
    document.body.innerHTML = `
      <article>
        <h1>Title Here</h1>
        <p>First <strong>bold</strong> sentence.</p>
        <p>Second paragraph.</p>
        <script>var x = 'ignored';</script>
        <p style="display:none">hidden text</p>
      </article>`;
    const idx = buildTextIndex(document.querySelector('article')!);
    expect(idx.fullText).toContain('Title Here');
    expect(idx.fullText).toContain('First bold sentence.');
    expect(idx.fullText).toContain('Second paragraph.');
    expect(idx.fullText).not.toContain('ignored');
    expect(idx.fullText).not.toContain('hidden text');
    // Block boundary inserts a newline between the heading and the first paragraph.
    expect(idx.fullText).toMatch(/Title Here\nFirst/);
  });

  it('rangeForSpan produces a DOM Range whose text matches the requested slice', () => {
    document.body.innerHTML = `<div id="root"><p>Alpha beta gamma.</p><p>Delta epsilon.</p></div>`;
    const root = document.getElementById('root')!;
    const idx = buildTextIndex(root);
    const needle = 'beta gamma';
    const start = idx.fullText.indexOf(needle);
    const range = rangeForSpan(idx, start, start + needle.length);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe(needle);
  });

  it('maps a span across two text nodes', () => {
    document.body.innerHTML = `<p id="root">one <em>two</em> three</p>`;
    const root = document.getElementById('root')!;
    const idx = buildTextIndex(root);
    const start = idx.fullText.indexOf('two');
    const end = idx.fullText.indexOf('three') + 'three'.length;
    const range = rangeForSpan(idx, start, end);
    expect(range).not.toBeNull();
    expect(range!.toString().replace(/\s+/g, ' ')).toBe('two three');
  });
});
