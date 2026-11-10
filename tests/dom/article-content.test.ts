// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractArticle } from '@/extract/readability';
import { resolveLiveRoot } from '@/extract/live-container';
import { buildTextIndex } from '@/extract/text-index';
import { buildArticlePlaylist } from '@/content/playlist';
import { ruleRoot, rulesFor, skipSelector } from '@/extract/site-rules';
import type { SkipSettings } from '@/shared/settings';

const NOTHING_SKIPPED: SkipSettings = { code: false, tables: false, captions: false, references: false };

/** What the reader would say on this page, as it plans a whole-page read (content/session.ts). */
function said(html: string, skip: SkipSettings = NOTHING_SKIPPED): string {
  document.body.innerHTML = html;
  const article = extractArticle(document);
  const rules = rulesFor(document, 'https://example.org/docs/page');
  const root = ruleRoot(rules, document) ?? resolveLiveRoot(article, document);
  const index = buildTextIndex(root, { forReader: true, skip: skipSelector(rules, skip) });
  const plan = buildArticlePlaylist({ index, lang: 'en', maxChars: 400, normalize: (t) => t, referenceText: article.text, title: article.title, skip, rules });
  return plan.filter((p) => p.eligible).map((p) => p.sourceText).join(' | ');
}

const para = (n: number): string =>
  `<p>Paragraph ${n} explains one more thing about constants and variables, at some length, so that the page reads like a real chapter of documentation.</p>`;

/** The Swift book (docs.swift.org): DocC puts each note in an <aside> between the paragraphs. */
const SWIFT = `
  <nav aria-label="API Reference"><a href="/">Documentation</a></nav>
  <main id="app-main"><div class="doc-content"><div class="primary-content"><div class="content">
    <h1>The Basics</h1>
    ${para(1)}
    ${para(2)}
    <h3 id="Type-Annotations">Type Annotations</h3>
    ${para(3)}
    <div class="code-listing"><pre><code>var red, green, blue: Double</code></pre></div>
    <aside aria-label="note" class="note"><p class="label">Note</p><p>It’s rare that you need to write type annotations in practice. If you provide an initial value for a constant or variable at the point that it’s defined, Swift can almost always infer the type, as described in <a href="#t">Type Safety and Type Inference</a>.</p></aside>
    <h3 id="Naming">Naming Constants and Variables</h3>
    ${para(4)}
    <aside aria-label="note" class="note"><p class="label">Note</p><p>All options you can use with string interpolation are described in <a href="#s">String Interpolation</a>.</p></aside>
    ${para(5)}
    ${para(6)}
  </div></div></div></main>`;

describe('what is read: the article’s own notes and asides', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads the notes in the Swift book, which sit in <aside> elements', () => {
    const text = said(SWIFT);
    expect(text).toContain('It’s rare that you need to write type annotations in practice.');
    expect(text).toContain('All options you can use with string interpolation are described in String Interpolation.');
    // In their place, after the code and before the next heading.
    expect(text.indexOf('It’s rare')).toBeGreaterThan(text.indexOf('Paragraph 3'));
    expect(text.indexOf('It’s rare')).toBeLessThan(text.indexOf('Naming Constants'));
  });

  it('reads note boxes named as such (MDN, Docusaurus, GitHub)', () => {
    const text = said(`<article>
      <h1>Using fetch</h1>
      ${para(1)}
      <div class="notecard note"><p><strong>Note:</strong> The fetch() method is controlled by the connect-src directive of the Content Security Policy rather than the directive of the resources it is retrieving.</p></div>
      ${para(2)}
      <div class="theme-admonition theme-admonition-warning admonition_xJq3 alert alert--warning"><div class="admonitionContent_BuS1"><p>Never call this from a loop that runs on every frame, or the page will stall.</p></div></div>
      ${para(3)}
      ${para(4)}
    </article>`);
    expect(text).toContain('The fetch() method is controlled by the connect-src directive');
    expect(text).toContain('Never call this from a loop that runs on every frame');
  });

  it('still leaves out the page’s sidebar, a pull quote and a newsletter box', () => {
    const text = said(`
      <aside class="sidebar"><h2>Popular</h2><p>Ten other things we wrote about, chosen for you by our editors this week.</p></aside>
      <article>
        <h1>The long road</h1>
        ${para(1)}
        <aside class="pullquote"><p>Paragraph 2 explains one more thing about constants and variables</p></aside>
        ${para(2)}
        <div class="newsletter-signup"><p>Get the best of our writing delivered to your inbox every morning.</p><form><input type="email"><button>Sign up</button></form></div>
        ${para(3)}
        ${para(4)}
      </article>`);
    expect(text).not.toContain('Ten other things');
    expect(text).not.toContain('delivered to your inbox');
    // The pull quote's sentence is said once, in the paragraph it comes from.
    expect(text.split('Paragraph 2 explains').length - 1).toBe(1);
  });

  it('reads the standfirst in the article’s own header', () => {
    const text = said(`
      <header class="site-header"><a href="/">The Daily Example</a><p>News, every day, from everywhere we can reach with a camera.</p></header>
      <article>
        <header><h1>The long road</h1><p class="standfirst">How a small town rebuilt its only bridge in a single, very wet summer.</p></header>
        ${para(1)}
        ${para(2)}
        ${para(3)}
      </article>`);
    expect(text).toContain('How a small town rebuilt its only bridge');
    expect(text).not.toContain('News, every day');
  });

  it('reads a passage Readability drops from the middle of the article for its class name', () => {
    // "header" in a class makes Readability remove the element unread; between two paragraphs it
    // kept, with nothing saying it is anything but the article, it is read.
    const text = said(`<article>
      <h1>Optionals</h1>
      ${para(1)}
      ${para(2)}
      <div class="section-header"><h2>Optional binding</h2><p>You use optional binding to find out whether an optional contains a value, and if so, to make that value available.</p></div>
      ${para(3)}
      ${para(4)}
    </article>`);
    expect(text).toContain('You use optional binding to find out whether an optional contains a value');
  });
});
