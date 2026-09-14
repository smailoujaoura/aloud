// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextIndex } from '@/extract/text-index';
import {
  buildArticlePlaylist,
  buildSelectionPlaylist,
  leadSilenceSec,
  type PlaylistItem,
} from '@/content/playlist';

const identity = (t: string): string => t;

function articlePlaylist(html: string, opts: { title?: string; maxChars?: number } = {}): PlaylistItem[] {
  document.body.innerHTML = html;
  const root = document.querySelector('article') ?? document.body;
  const index = buildTextIndex(root);
  return buildArticlePlaylist({
    index,
    lang: 'en',
    maxChars: opts.maxChars ?? 240,
    normalize: identity,
    referenceText: index.fullText,
    title: opts.title ?? 'Title',
  });
}

describe('buildArticlePlaylist (happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('numbers playIds contiguously from zero in document order', () => {
    const items = articlePlaylist(`
      <article>
        <h1>Big Title</h1>
        <p>First sentence here. Second sentence here.</p>
        <p>Third sentence lives in its own paragraph.</p>
      </article>`);

    expect(items.map((i) => i.playId)).toEqual(items.map((_, n) => n));
    expect(items.length).toBeGreaterThanOrEqual(4);
  });

  it('locates a range in the live DOM for every sentence that is in the DOM', () => {
    const items = articlePlaylist(
      `<article><h1>Present Title</h1><p>A plain paragraph of readable text.</p></article>`,
      { title: 'Present Title' },
    );

    expect(items).not.toHaveLength(0);
    for (const item of items) expect(item.range).not.toBeNull();
  });

  it('still speaks a title that is absent from the DOM, with nothing to highlight', () => {
    // Readability often recovers a title from <title> or metadata that appears nowhere in the
    // article body. It should be read aloud, but there is no range to highlight for it.
    const items = articlePlaylist(`<article><p>Body text with no heading element.</p></article>`, {
      title: 'A Title That Is Not In The Body',
    });

    const spokenOnly = items.filter((i) => i.range === null);
    expect(spokenOnly).toHaveLength(1);
    expect(spokenOnly[0]?.spokenText).toBe('A Title That Is Not In The Body');
    expect(spokenOnly[0]?.isHeading).toBe(true);
    expect(spokenOnly[0]?.playId).toBe(0);
  });

  it('flags the first sentence of each block, and marks headings', () => {
    const items = articlePlaylist(`
      <article>
        <h2>A Heading</h2>
        <p>First sentence here. Second sentence here.</p>
      </article>`);

    const heading = items.find((i) => i.isHeading);
    expect(heading).toBeDefined();
    expect(heading?.startsBlock).toBe(true);

    const body = items.filter((i) => !i.isHeading);
    expect(body[0]?.startsBlock).toBe(true);
    // A later sentence in the same paragraph continues the block.
    expect(body[1]?.startsBlock).toBe(false);
  });

  it('falls back to the enclosing block range for sentences inside a located block', () => {
    const items = articlePlaylist(
      `<article><h1>Shared</h1><p>One sentence. Two sentence. Three sentence.</p></article>`,
      { title: 'Shared' },
    );

    // Every sentence that belongs to a real block has something to highlight, so the reader's
    // eye is never left stranded mid-article.
    for (const item of items) expect(item.range ?? item.blockRange).not.toBeNull();
  });

  it('splits over-long text so a single chunk cannot stall playback', () => {
    const long = `${'word '.repeat(200)}.`;
    const items = articlePlaylist(`<article><p>${long}</p></article>`, { maxChars: 80 });
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) expect(item.spokenText.length).toBeLessThanOrEqual(160);
  });
});

describe('buildSelectionPlaylist (happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('segments the selected text and numbers it from zero', () => {
    document.body.innerHTML = `<div id="r"><p>Alpha sentence one. Beta sentence two.</p></div>`;
    const index = buildTextIndex(document.getElementById('r')!);
    const items = buildSelectionPlaylist({
      index,
      lang: 'en',
      maxChars: 240,
      normalize: identity,
      sourceText: 'Alpha sentence one. Beta sentence two.',
    });

    expect(items.map((i) => i.playId)).toEqual(items.map((_, n) => n));
    expect(items.length).toBe(2);
    // Selection mode has no block structure to fall back on.
    expect(items.every((i) => i.blockRange === null)).toBe(true);
  });
});

describe('leadSilenceSec', () => {
  const base = { playId: 1, spokenText: 'x', sourceText: 'x', range: null, blockRange: null, role: 'paragraph' as const };

  it('is zero when both pause settings are off', () => {
    const item: PlaylistItem = { ...base, startsBlock: true, isHeading: false };
    expect(leadSilenceSec(item, { sentencePauseMs: 0, sectionPauseMs: 0 })).toBe(0);
  });

  it('uses the sentence pause for a sentence mid-block', () => {
    const item: PlaylistItem = { ...base, startsBlock: false, isHeading: false };
    expect(leadSilenceSec(item, { sentencePauseMs: 200, sectionPauseMs: 800 })).toBeCloseTo(0.2);
  });

  it('takes the larger section pause when a new block starts', () => {
    const item: PlaylistItem = { ...base, startsBlock: true, isHeading: false };
    expect(leadSilenceSec(item, { sentencePauseMs: 200, sectionPauseMs: 800 })).toBeCloseTo(0.8);
  });

  it('gives a heading an audible beat even with pauses turned off', () => {
    const item: PlaylistItem = { ...base, startsBlock: true, isHeading: true };
    expect(leadSilenceSec(item, { sentencePauseMs: 0, sectionPauseMs: 0 })).toBeCloseTo(0.25);
  });

  it('never delays the very first item', () => {
    const first: PlaylistItem = { ...base, playId: 0, startsBlock: true, isHeading: true };
    expect(leadSilenceSec(first, { sentencePauseMs: 0, sectionPauseMs: 0 })).toBe(0);
  });

  it('is zero for a missing item rather than throwing', () => {
    expect(leadSilenceSec(undefined, { sentencePauseMs: 500, sectionPauseMs: 500 })).toBe(0);
  });
});

describe('prose wrapped across source lines (happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * The walkthrough's own demo paragraph, wrapped in the markup the way almost all HTML is. The
   * text index copies text nodes verbatim, so those newlines reach the segmenter — and used to be
   * read as sentence ends, stopping the reader dead in the middle of every line.
   */
  it('plans one chunk per sentence, not one per line of markup', () => {
    const items = articlePlaylist(
      `<article>
        <p>
          This is Aloud. It reads the page you are on with a voice that runs entirely on your
          own computer, and it follows along, sentence by sentence, so you never lose your
          place. Press the button and hear it for yourself.
        </p>
      </article>`,
      { title: 'Aloud' },
    );

    const spoken = items.filter((i) => i.range).map((i) => i.spokenText.replace(/\s+/g, ' ').trim());
    expect(spoken).toEqual([
      'This is Aloud.',
      'It reads the page you are on with a voice that runs entirely on your own computer, ' +
        'and it follows along, sentence by sentence, so you never lose your place.',
      'Press the button and hear it for yourself.',
    ]);
  });

  it('still starts a new chunk at a real paragraph boundary', () => {
    const items = articlePlaylist(
      `<article>
        <p>
          A first paragraph that wraps
          across two lines
        </p>
        <p>
          A second paragraph that also
          wraps across two lines
        </p>
      </article>`,
      { title: 'Two paragraphs' },
    );

    const spoken = items.filter((i) => i.range).map((i) => i.spokenText.replace(/\s+/g, ' ').trim());
    expect(spoken).toEqual([
      'A first paragraph that wraps across two lines',
      'A second paragraph that also wraps across two lines',
    ]);
  });
});

describe('skipping parts of an article (happy-dom)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const html = `<article>
    <h1>Guide</h1>
    <p>Install the package first.</p>
    <pre><code>npm install something --save</code></pre>
    <table><tr><td>Cell text that is tabular.</td></tr></table>
    <figure><figcaption>A caption under a picture.</figcaption></figure>
    <p>Then run it and read the output.</p>
    <h2>See also</h2>
    <p>Another guide worth reading later.</p>
    <h2>References [edit]</h2>
    <ol class="references"><li>Smith, J. A reference entry.</li></ol>
  </article>`;

  function spoken(skip?: { code: boolean; tables: boolean; captions: boolean; references: boolean }): string[] {
    document.body.innerHTML = html;
    const root = document.querySelector('article')!;
    const index = buildTextIndex(root);
    return buildArticlePlaylist({
      index, lang: 'en', maxChars: 240, normalize: identity,
      referenceText: index.fullText, title: 'Guide', skip,
    }).map((i) => i.spokenText.replace(/\s+/g, ' ').trim());
  }

  it('reads everything when nothing is skipped', () => {
    const all = spoken();
    expect(all).toContain('npm install something --save');
    expect(all).toContain('Smith, J. A reference entry.');
  });

  it('skips each kind of block on its own switch', () => {
    const out = spoken({ code: true, tables: true, captions: true, references: false });
    expect(out).not.toContain('npm install something --save');
    expect(out).not.toContain('Cell text that is tabular.');
    expect(out).not.toContain('A caption under a picture.');
    expect(out).toContain('Install the package first.');
    expect(out).toContain('Then run it and read the output.');
  });

  it('skips a reference section from its heading to the end of that section', () => {
    const out = spoken({ code: false, tables: false, captions: false, references: true });
    expect(out).not.toContain('See also');
    expect(out).not.toContain('Another guide worth reading later.');
    expect(out).not.toContain('Smith, J. A reference entry.');
    expect(out).toContain('Then run it and read the output.');
  });
});
