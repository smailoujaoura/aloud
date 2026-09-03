// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextIndex } from '@/extract/text-index';
import { buildBlockModel } from '@/extract/block-model';

function model(html: string, opts?: { referenceText?: string; title?: string }) {
  document.body.innerHTML = html;
  const root = document.querySelector('article') ?? document.body;
  const index = buildTextIndex(root);
  const blocks = buildBlockModel(index, opts).map((b) => ({
    ...b,
    text: index.fullText.slice(b.start, b.end),
  }));
  return { index, blocks };
}

describe('buildBlockModel (happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('yields blocks in document order with structural roles', () => {
    const { blocks } = model(`
      <article>
        <h1>Big Title</h1>
        <p>First paragraph of the body text.</p>
        <h2>A Subsection</h2>
        <p>Second paragraph under the subsection.</p>
        <ul><li>Point one here.</li><li>Point two here.</li></ul>
        <blockquote>A quoted remark.</blockquote>
        <figure><figcaption>An image caption.</figcaption></figure>
      </article>`);

    expect(blocks.map((b) => b.role)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
      'listitem',
      'listitem',
      'quote',
      'caption',
    ]);
    expect(blocks[0]!.level).toBe(1);
    expect(blocks[2]!.level).toBe(2);
    expect(blocks[1]!.text).toContain('First paragraph');
    // order preserved
    expect(blocks[3]!.start).toBeGreaterThan(blocks[2]!.start);
  });

  it('keeps inline <code> inside the sentence text', () => {
    const { blocks } = model(
      `<article><p>Call <code>useState()</code> at the top of the component.</p></article>`,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('Call useState() at the top of the component.');
  });

  it('drops boilerplate blocks absent from the reference text', () => {
    const { blocks } = model(
      `<article>
        <p>This is the real article body that we want to read aloud.</p>
        <p>Subscribe to our newsletter for more updates every week.</p>
      </article>`,
      { referenceText: 'This is the real article body that we want to read aloud. '.repeat(6) },
    );
    expect(blocks.map((b) => b.text).join(' ')).toContain('real article body');
    expect(blocks.map((b) => b.text).join(' ')).not.toContain('newsletter');
  });

  it('prepends the title as the first block, located in the DOM when present', () => {
    const { blocks } = model(
      `<article><h1>Located Title</h1><p>Body sentence here.</p></article>`,
      { title: 'Located Title' },
    );
    expect(blocks[0]!.role).toBe('title');
    expect(blocks[0]!.text).toBe('Located Title');
    expect(blocks[0]!.end).toBeGreaterThan(blocks[0]!.start);
  });

  it('emits a spoken-only title block when the title is not in the DOM', () => {
    const { blocks } = model(`<article><p>Body sentence here.</p></article>`, {
      title: 'Detached Title',
    });
    expect(blocks[0]!.role).toBe('title');
    expect(blocks[0]!.start).toBe(blocks[0]!.end); // no range
  });
});
