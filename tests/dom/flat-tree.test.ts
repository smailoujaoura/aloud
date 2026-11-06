// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { deepQueryAll, flatCopy, flatNodes, flatText, hasShadowRoots, renderedParent, shadowRootsOf } from '@/extract/flat-tree';

/** An MSN-like page: the article inside a component inside a component, with a slotted byline. */
function msnLike(): { host: HTMLElement; inner: HTMLElement; byline: HTMLElement } {
  document.body.innerHTML = '<header>Site</header><msn-article><p slot="byline" id="by">By A. Writer</p></msn-article><footer>Footer</footer>';
  const host = document.querySelector('msn-article') as HTMLElement;
  const outer = host.attachShadow({ mode: 'open' });
  outer.innerHTML = '<div class="byline"><slot name="byline"></slot></div><article-body></article-body>';
  const inner = outer.querySelector('article-body') as HTMLElement;
  const body = inner.attachShadow({ mode: 'open' });
  body.innerHTML = '<h1>The headline</h1><p>First paragraph of the story.</p><p>Second paragraph.</p>';
  return { host, inner, byline: document.getElementById('by') as HTMLElement };
}

describe('the page as it is drawn, through web components', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the components, and nothing on a page without any', () => {
    document.body.innerHTML = '<article><p>Plain page.</p></article>';
    expect(hasShadowRoots(document)).toBe(false);
    msnLike();
    expect(hasShadowRoots(document)).toBe(true);
  });

  it('reads the text in drawn order: the slotted byline where its slot is, then the story', () => {
    const { host } = msnLike();
    expect(flatText(host)).toBe('By A. WriterThe headlineFirst paragraph of the story.Second paragraph.');
    expect([...flatNodes(document.body)].map((n) => n.nodeValue).join('|')).toBe('Site|By A. Writer|The headline|First paragraph of the story.|Second paragraph.|Footer');
  });

  it('goes up through components and past slots', () => {
    const { host, inner, byline } = msnLike();
    const para = inner.shadowRoot!.querySelectorAll('p')[0]!;
    // The paragraph's first parent is nothing (the top of its shadow root): the component is.
    expect(renderedParent(para)).toBe(inner);
    expect(renderedParent(inner)).toBe(host);
    // A slotted element is drawn in the slot's parent, not the slot (no box of its own).
    expect(renderedParent(byline)?.className).toBe('byline');
  });

  it('finds elements inside components, and the shadow roots holding some text', () => {
    const { inner } = msnLike();
    expect(deepQueryAll(document, 'p').length).toBe(3);
    const texts = [...flatNodes(document.body)];
    expect(shadowRootsOf(texts)).toEqual([inner.shadowRoot]);
  });

  it('copies the page with its components in place, for Readability', () => {
    msnLike();
    const copy = flatCopy(document);
    expect(copy.body.querySelectorAll('p').length).toBe(3);
    expect(copy.body.querySelector('h1')?.textContent).toBe('The headline');
    expect(copy.querySelector('slot')).toBeNull();
    expect(copy.body.textContent).toContain('Second paragraph.');
  });
});

describe('the text index through web components', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('indexes the story inside its components, in drawn order', async () => {
    const { buildTextIndex } = await import('@/extract/text-index');
    msnLike();
    const index = buildTextIndex(document.body);
    expect(index.fullText).toContain('By A. Writer');
    expect(index.fullText).toContain('First paragraph of the story.');
    expect(index.fullText.indexOf('The headline')).toBeLessThan(index.fullText.indexOf('Second paragraph.'));
  });

  it('only the blocks the article kept, when told (MSN puts promotions beside them)', async () => {
    const { buildTextIndex } = await import('@/extract/text-index');
    const { inner } = msnLike();
    const paras = [...inner.shadowRoot!.querySelectorAll('p')];
    const index = buildTextIndex(document.body, { within: new Set(paras) });
    expect(index.fullText).toBe('First paragraph of the story.\nSecond paragraph.');
  });

  it('a range never spans two components: it ends in the one it starts in', async () => {
    const { buildTextIndex, rangeForSpan } = await import('@/extract/text-index');
    msnLike();
    const index = buildTextIndex(document.body);
    const from = index.fullText.indexOf('By A. Writer');
    const range = rangeForSpan(index, from, index.fullText.indexOf('Second paragraph.'))!;
    expect(range.collapsed).toBe(false);
    expect(range.startContainer.getRootNode()).toBe(range.endContainer.getRootNode());
  });
});
