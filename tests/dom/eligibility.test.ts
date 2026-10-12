// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextIndex, refreshEligibility, spanEligible } from '@/extract/text-index';
import { buildArticlePlaylist, buildSelectionPlaylist, type PlaylistItem } from '@/content/playlist';
import { extractArticle } from '@/extract/readability';

const identity = (t: string): string => t;

// The shape of a bilingual story site: each paragraph followed by a "Translate?" div and its
// translation, collapsed with opacity 0 and height 0 (not display: none).
const STYLE = `
  .lan2{opacity:0;height:0;display:block}
  .trans-link{cursor:pointer;display:inline-block;text-transform:uppercase}
  .switch{cursor:pointer;display:inline-block;width:40px;height:20px}
  .switch-label{display:inline-block}`;

const STORY = `
  <article>
    <h1>Chicken Little</h1>
    <div><div class="switch"></div><div class="switch-label">Show all translations?</div></div>
    <div class="pair"><p>Lasciate che vi racconti la storia di un pollo piccolino.</p><div class="trans-link">Translate?</div>
      <div class="lan2"><p>Let me tell you the story of a little chicken.</p></div></div>
    <div class="pair"><p>Un giorno una ghianda gli cadde sulla testa e il pollo corse via.</p><div class="trans-link">Translate?</div>
      <div class="lan2"><p>One day an acorn fell on his head and the chicken ran away.</p></div></div>
    <p>No!</p>
    <p>Potete leggere <a href="#">la versione originale</a> alla fine di questa pagina.</p>
  </article>`;

function load(html: string): void {
  document.head.innerHTML = `<style>${STYLE}</style>`;
  document.body.innerHTML = html;
}

function plan(): { items: PlaylistItem[]; index: ReturnType<typeof buildTextIndex> } {
  const index = buildTextIndex(document.querySelector('article')!, { forReader: true });
  const items = buildArticlePlaylist({ index, lang: 'it', maxChars: 240, normalize: identity, referenceText: index.fullText, title: '' });
  return { items, index };
}

const read = (items: PlaylistItem[]): string[] => items.filter((i) => i.eligible).map((i) => i.sourceText.trim());

describe('what the reader reads', () => {
  beforeEach(() => load(STORY));

  it('reads the visible story, not its collapsed translations or its controls', () => {
    const { items } = plan();
    expect(read(items)).toEqual([
      'Chicken Little',
      'Lasciate che vi racconti la storia di un pollo piccolino.',
      'Un giorno una ghianda gli cadde sulla testa e il pollo corse via.',
      'No!',
      'Potete leggere la versione originale alla fine di questa pagina.',
    ]);
    // Controls are not even candidates; hidden translations are, for when they are revealed.
    const all = items.map((i) => i.sourceText).join(' ');
    expect(all).not.toMatch(/Translate\?|Show all translations/);
    expect(all).toContain('Let me tell you');
  });

  it('reads a translation once it is revealed, and stops when it is hidden again', () => {
    const { items, index } = plan();
    const lan2 = document.querySelectorAll<HTMLElement>('.lan2')[1]!;
    const acorn = items.find((i) => i.sourceText.includes('acorn'))!;
    expect(acorn.eligible).toBe(false);

    lan2.style.opacity = '1';
    lan2.style.height = 'auto';
    expect(refreshEligibility(index)).toBe(true);
    expect(spanEligible(index, acorn.span!.start, acorn.span!.end)).toBe(true);

    lan2.style.opacity = '0';
    expect(refreshEligibility(index)).toBe(true);
    expect(spanEligible(index, acorn.span!.start, acorn.span!.end)).toBe(false);
    expect(refreshEligibility(index)).toBe(false);
  });

  it('keeps short prose and inline links, which have none of a control’s signs', () => {
    const { items } = plan();
    expect(read(items)).toContain('No!');
    expect(read(items).some((t) => t.includes('la versione originale'))).toBe(true);
  });

  it('treats ARIA widgets and toggles as controls, and reads through display: contents', () => {
    load(`<article>
      <p>Il primo paragrafo della storia è abbastanza lungo da contare.</p>
      <div role="button">Mostra</div>
      <div aria-expanded="false" style="display:block">Altro</div>
      <div style="display:contents"><p>Il secondo paragrafo passa attraverso un contenitore senza scatola.</p></div>
    </article>`);
    expect(read(plan().items)).toEqual([
      'Il primo paragrafo della storia è abbastanza lungo da contare.',
      'Il secondo paragrafo passa attraverso un contenitore senza scatola.',
    ]);
  });

  it('leaves out the body of a closed <details>, and reads it once opened', () => {
    load(`<article>
      <p>Una frase visibile prima dei dettagli, abbastanza lunga.</p>
      <details><summary>Note</summary><p>Il testo nascosto nei dettagli chiusi della pagina.</p></details>
    </article>`);
    const { items, index } = plan();
    expect(read(items)).not.toContain('Il testo nascosto nei dettagli chiusi della pagina.');
    document.querySelector('details')!.setAttribute('open', '');
    refreshEligibility(index);
    const hidden = items.find((i) => i.sourceText.includes('nascosto'))!;
    expect(spanEligible(index, hidden.span!.start, hidden.span!.end)).toBe(true);
  });

  it('a selection dragged across a collapsed translation reads only what shows', () => {
    const index = buildTextIndex(document.querySelector('article')!, { forReader: true });
    const items = buildSelectionPlaylist({
      index,
      lang: 'it',
      maxChars: 240,
      normalize: identity,
      sourceText:
        'Lasciate che vi racconti la storia di un pollo piccolino. Let me tell you the story of a little chicken. ' +
        'Un giorno una ghianda gli cadde sulla testa e il pollo corse via.',
    });
    expect(read(items)).toEqual([
      'Lasciate che vi racconti la storia di un pollo piccolino.',
      'Un giorno una ghianda gli cadde sulla testa e il pollo corse via.',
    ]);
  });

  it('a saved copy leaves out hidden translations and controls; the reader’s keeps hidden ones', () => {
    const saved = extractArticle(document, { forSaving: true });
    expect(saved.text).not.toMatch(/Let me tell you|Translate\?|Show all translations/);
    expect(saved.text).toContain('Lasciate che vi racconti');
    const live = extractArticle(document);
    expect(live.text).not.toMatch(/Translate\?/);
  });

  it('the plain index, for page annotations, is unchanged', () => {
    const index = buildTextIndex(document.querySelector('article')!);
    expect(index.forReader).toBeUndefined();
    expect(index.fullText).toContain('Translate?');
  });
});
