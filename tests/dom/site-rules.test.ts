// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextIndex } from '@/extract/text-index';
import { buildArticlePlaylist } from '@/content/playlist';
import { rulesFor, skipSelector, ruleRoot, savedRules } from '@/extract/site-rules';
import { extractArticle } from '@/extract/readability';
import { readableLength } from '@/content/skip-rules';
import { DEFAULT_SKIP, type SkipSettings } from '@/shared/settings';

/** Current MediaWiki (Parsoid) markup, cut down: what a Wikipedia article looks like to the reader. */
const WIKI = `
  <meta name="generator" content="MediaWiki 1.47.0-wmf.24">
  <main id="content"><div id="mw-content-text"><div class="mw-parser-output">
    <div class="hatnote navigation-not-searchable">This article is about the decoction. For the vine, see Banisteriopsis caapi.</div>
    <table class="infobox"><tr><th>Ayahuasca</th></tr><tr><td>Source plant: Liana</td></tr></table>
    <p>Ayahuasca<sup class="mw-ref reference"><a href="#n1">[note 1]</a></sup> is a South American psychoactive decoction prepared from the vine.<sup class="reference"><a href="#c2">[1]</a></sup> It is used by Indigenous cultures in the Amazon basin as part of traditional medicine.</p>
    <div class="mw-heading mw-heading2"><h2 id="Preparation">Preparation</h2><span class="mw-editsection">[<a href="#">edit</a>]</span></div>
    <p>Sections of the vine are macerated and boiled alone or with leaves from any of a number of other plants, for several hours.</p>
    <div class="mw-heading mw-heading2"><h2 id="Note">Note</h2><span class="mw-editsection">[<a href="#">modifica</a> | <a href="#">modifica wikitesto</a>]</span></div>
    <ol class="references"><li>Pronounced as ayahuasca in the UK, with a long list of sources that follows here.</li></ol>
    <div class="mw-heading mw-heading2"><h2 id="Weblinks">Weblinks</h2></div>
    <ul><li>An external link that should never be read, a long description of a website here.</li></ul>
  </div></div></main>`;

describe('site rules on a Wikipedia article', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = WIKI;
  });

  it('finds MediaWiki and the article root', () => {
    const rules = rulesFor(document, 'https://it.wikipedia.org/wiki/Ayahuasca');
    expect(rules.ids).toContain('mediawiki');
    expect(rules.ids).toContain('wikipedia.it');
    expect(ruleRoot(rules, document)?.className).toBe('mw-parser-output');
  });

  it('reads the prose without markers, [edit], hatnote, infobox, Note or Weblinks', () => {
    const rules = rulesFor(document, 'https://it.wikipedia.org/wiki/Ayahuasca');
    const root = ruleRoot(rules, document)!;
    const index = buildTextIndex(root, { forReader: true, skip: skipSelector(rules, DEFAULT_SKIP) });
    const plan = buildArticlePlaylist({ index, lang: 'en', maxChars: 300, normalize: (t) => t, referenceText: index.fullText, title: '', skip: DEFAULT_SKIP, rules });
    const said = plan.filter((p) => p.eligible).map((p) => p.spokenText).join(' | ');
    expect(said).toContain('Ayahuasca is a South American psychoactive decoction prepared from the vine.');
    expect(said).toContain('Preparation');
    expect(said).not.toMatch(/\[|note 1|edit|modifica|This article is about|Source plant|Pronounced|external link/);
  });

  it('the estimate counts what is read, not the apparatus', () => {
    const rules = rulesFor(document, 'https://it.wikipedia.org/wiki/Ayahuasca');
    const all = (document.querySelector('.mw-parser-output')!.textContent ?? '').replace(/\s+/g, ' ').length;
    const read = readableLength(document.querySelector('.mw-parser-output')!, DEFAULT_SKIP, rules);
    expect(read).toBeLessThan(all * 0.65);
    expect(read).toBeGreaterThan(200);
  });
});

describe('a Wikipedia article saved for later (the reading queue)', () => {
  /** Save as the queue does, then plan the saved copy as the queue's reader does. */
  function savedPlan(skip: SkipSettings): string {
    document.head.innerHTML = '<meta name="generator" content="MediaWiki 1.47.0-wmf.24"><title>Ayahuasca</title>';
    document.body.innerHTML = WIKI.replace(/<meta[^>]*>/, '');
    const saved = extractArticle(document, { forSaving: true, url: 'https://en.wikipedia.org/wiki/Ayahuasca' });
    const host = document.createElement('article');
    host.innerHTML = saved.html;
    document.body.replaceChildren(host);
    const rules = savedRules(document);
    const index = buildTextIndex(host, { forReader: true, skip: skipSelector(rules, skip) });
    const plan = buildArticlePlaylist({ index, lang: 'en', maxChars: 300, normalize: (t) => t, referenceText: index.fullText, title: '', skip, rules });
    return plan.filter((p) => p.eligible).map((p) => p.spokenText).join(' | ');
  }

  it('is read as the page was: no markers, [edit], infobox, notes or links', () => {
    const said = savedPlan(DEFAULT_SKIP);
    expect(said).toContain('Ayahuasca is a South American psychoactive decoction prepared from the vine.');
    expect(said).toContain('Sections of the vine are macerated');
    expect(said).not.toMatch(/\[|note 1|edit|modifica|Source plant|Pronounced|external link/);
  });

  it('keeps what was marked, so references are read again when the setting says so', () => {
    const said = savedPlan({ ...DEFAULT_SKIP, references: false });
    expect(said).toContain('Pronounced as ayahuasca');
    expect(said).toMatch(/\[1\]/);
    // Never read either way: the infobox and the edit links.
    expect(said).not.toMatch(/Source plant|modifica/);
  });
});
