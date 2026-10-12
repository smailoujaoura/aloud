import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { segmentSentences } from '@/segment/sentences';

describe('segmentSentences', () => {
  it('splits a simple paragraph into sentences with round-tripping offsets', () => {
    const text = 'The sky is blue. Grass is green! Is water wet? Yes.';
    const chunks = segmentSentences(text);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
    expect(chunks[0]!.text).toBe('The sky is blue.');
  });

  it('does not break on the abbreviation "Dr."', () => {
    const text = 'Dr. Smith arrived early. She was tired.';
    const chunks = segmentSentences(text);
    expect(chunks[0]!.text).toContain('Dr. Smith arrived early.');
    expect(chunks).toHaveLength(2);
  });

  /**
   * Cited prose, the way Wikipedia writes it. `Intl.Segmenter` breaks *between* "[" and "3]",
   * which used to misalign every boundary in the paragraph and end up chopping it at commas.
   */
  it('breaks at the full stop, not inside a reference marker', () => {
    const text =
      'The subscription model offers a renewable revenue stream, although vulnerable to ' +
      'cancellation.[3] If a significant number are cancelled, the viability of the business ' +
      'can be placed in jeopardy.[34] The ease of canceling leaves customers with leverage.[35]';

    const chunks = segmentSentences(text, { maxChars: 240 });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.text).toMatch(/^The subscription model .* cancellation\.\[3\]$/);
    expect(chunks[1]!.text).toMatch(/^If a significant number .* jeopardy\.\[34\]$/);
    expect(chunks[2]!.text).toMatch(/^The ease of canceling .* leverage\.\[35\]$/);
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text);
  });

  it('keeps a sentence whose only comma is near its start in two clauses, not three fragments', () => {
    const text =
      'While recurring revenues can help the business and attract investors, the need for ' +
      'customer service skills in convincing the customer to renew their subscription is a ' +
      'challenge for providers switching to subscription from other revenue models.';

    const chunks = segmentSentences(text, { maxChars: 160 });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe(
      'While recurring revenues can help the business and attract investors,',
    );
    expect(chunks[1]!.text).toMatch(/^the need for customer service skills .* revenue models\.$/);
  });

  it('overruns maxChars rather than cutting a clause-free sentence at a space', () => {
    const text =
      'The quick brown fox jumped over the lazy dog again and again and again while nobody ' +
      'in the entire village was watching it happen at all that afternoon.';
    expect(text.length).toBeGreaterThan(140);

    const chunks = segmentSentences(text, { maxChars: 120 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
  });

  it('still hard-wraps a runaway span with no punctuation at all', () => {
    const text = `${'word '.repeat(120)}end.`;
    const chunks = segmentSentences(text, { maxChars: 120 });

    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(240);
  });

  it('clause-splits an over-long sentence', () => {
    const long =
      'This is a deliberately long sentence that goes on and on about nothing in particular; ' +
      'it then continues past a semicolon, and keeps adding clauses separated by commas, ' +
      'until it is definitely longer than the configured maximum chunk length for synthesis.';
    const chunks = segmentSentences(long, { maxChars: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(120);
  });

  it('assigns sequential indices', () => {
    const chunks = segmentSentences('One. Two. Three.');
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('handles text with no terminal punctuation', () => {
    const chunks = segmentSentences('just a fragment with no period');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('just a fragment with no period');
  });
});

describe('prose wrapped across source lines', () => {
  // Exactly the walkthrough's demo paragraph, indented across three lines the way it is written
  // in welcome/index.html. buildTextIndex copies text nodes verbatim, so this is what the
  // segmenter really sees for most of the web.
  const wrapped = [
    'This is Aloud. It reads the page you are on with a voice that runs entirely on your',
    '              own computer, and it follows along, sentence by sentence, so you never lose your',
    '              place. Press the button and hear it for yourself.',
  ].join('\n');

  const flat = (c: { text: string }): string => c.text.replace(/\s+/g, ' ');

  it('does not break a sentence where the markup happens to wrap', () => {
    expect(segmentSentences(wrapped).map(flat)).toEqual([
      'This is Aloud.',
      'It reads the page you are on with a voice that runs entirely on your own computer, ' +
        'and it follows along, sentence by sentence, so you never lose your place.',
      'Press the button and hear it for yourself.',
    ]);
  });

  it('keeps offsets pointing at the original text, newlines and all', () => {
    for (const chunk of segmentSentences(wrapped)) {
      expect(wrapped.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  it('still treats a blank line as a real break', () => {
    const chunks = segmentSentences('A first thought that trails off\n\nA second one entirely');
    expect(chunks).toHaveLength(2);
  });
});

describe('other line-break characters', () => {
  it('treats a CRLF wrap as a space, not a sentence end', () => {
    const chunks = segmentSentences('A sentence that wraps\r\nacross two lines here. And another.');
    expect(chunks.map((c) => c.text.replace(/\s+/g, ' '))).toEqual([
      'A sentence that wraps across two lines here.',
      'And another.',
    ]);
  });

  it('still breaks on a CRLF blank line', () => {
    expect(segmentSentences('A first thought\r\n\r\nA second thought')).toHaveLength(2);
  });

  it('keeps U+2029 as the paragraph separator it is', () => {
    expect(segmentSentences('A first thought A second thought')).toHaveLength(2);
  });
});

describe('short quoted replies', () => {
  const narration = 'Ma il porcellino vide le grosse zampe del lupo attraverso il buco della serratura, perciò rispose:';

  it.each([['“', '”'], ['"', '"'], ['«', '»']])('keeps a reply in %s%s together after its introduction', (open, close) => {
    const reply = `${open}No! No! No! Vattene! Vattene!${close}`;
    const text = `${narration} ${reply} Il lupo se ne andò.`;
    const chunks = segmentSentences(text, { locale: 'it' });
    expect(chunks.map(c => c.text)).toEqual([narration, reply, 'Il lupo se ne andò.']);
    for (const chunk of chunks) expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
  });

  it('does not group an unclosed quote or separate an inline quoted term', () => {
    expect(segmentSentences('He said: “No! No!').map(c => c.text)).toEqual(['He said: “No!', 'No!']);
    expect(segmentSentences('Define: "word" means a unit of language.')).toHaveLength(1);
  });

  it('preserves paragraph and sentence boundaries within long quotations', () => {
    const text = 'He said: “No!\n\nGo away!”';
    expect(segmentSentences(text)).toHaveLength(2);
    const long = `He said: “${'Stay right here! '.repeat(30)}Go away!”`;
    const chunks = segmentSentences(long, { maxChars: 80 });
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.every(c => c.text.length <= 80)).toBe(true);
  });
});

describe('utterances: dialogue said the way people say it', () => {
  const utter = (text: string, locale = 'en') => segmentSentences(text, { locale, maxChars: 160, utterances: true });
  const said = (text: string, locale = 'en') => utter(text, locale).map((c) => c.text);

  it('keeps every group a verbatim slice, so highlights and seeking stay exact', () => {
    const corpus = JSON.parse(readFileSync('tests/fixtures/dialogue.json', 'utf8')) as Record<string, string[]>;
    for (const [lang, texts] of Object.entries(corpus)) {
      for (const text of texts) {
        for (const c of utter(text, lang)) {
          expect(text.slice(c.start, c.end)).toBe(c.text);
          expect(c.text.length).toBeLessThanOrEqual(160);
        }
      }
    }
  });

  it('a reply and its attribution are one utterance, with or without a colon', () => {
    expect(said('"No!" he said. "Go away!"')).toEqual(['"No!" he said. "Go away!"']);
    expect(said('"Is that you?" asked Tom. "It\'s me," Mary answered.')).toEqual(['"Is that you?" asked Tom.', '"It\'s me," Mary answered.']);
    expect(said('«No!» disse il pollo. «Vattene!»', 'it')).toEqual(['«No!» disse il pollo. «Vattene!»']);
    expect(said('—¡No! —gritó el pollo—. ¡Vete! El zorro se fue.', 'es')).toEqual(['—¡No! —gritó el pollo—. ¡Vete!', 'El zorro se fue.']);
  });

  it('narration up to "rispose:" and then the whole reply', () => {
    expect(said('La volpe chiese che cosa fosse successo, e il pollo rispose: «No! No! No! Vattene! Vattene!»', 'it')).toEqual([
      'La volpe chiese che cosa fosse successo, e il pollo rispose:',
      '«No! No! No! Vattene! Vattene!»',
    ]);
  });

  it('French: the closing guillemet stays with its reply', () => {
    expect(said('« Non ! » dit le poulet. « Va-t\'en ! » Le renard recula.', 'fr')).toEqual([
      '« Non ! » dit le poulet. « Va-t\'en ! »',
      'Le renard recula.',
    ]);
  });

  it('very short sentences are said with a neighbour; ordinary short sentences are not', () => {
    expect(said('Yes. No. Maybe. It depends on the weather tomorrow morning.')).toEqual(['Yes. No. Maybe.', 'It depends on the weather tomorrow morning.']);
    expect(said('Well... I don\'t know. It is late.')).toEqual(['Well... I don\'t know.', 'It is late.']);
    expect(said('This is Aloud. It reads the page.')).toEqual(['This is Aloud.', 'It reads the page.']);
  });

  it('abbreviations in other languages do not end a sentence', () => {
    expect(said('Il Sig. Rossi arrivò alle cinque in punto.', 'it')).toEqual(['Il Sig. Rossi arrivò alle cinque in punto.']);
    expect(said('La Sra. García llegó tarde a la reunión.', 'es')).toEqual(['La Sra. García llegó tarde a la reunión.']);
    expect(said('Er kam z. B. um fünf Uhr nach Hause.', 'de')).toEqual(['Er kam z. B. um fünf Uhr nach Hause.']);
  });

  it('never joins across a blank line or past the length bound', () => {
    expect(said('No!\n\nYes!')).toEqual(['No!', 'Yes!']);
    const long = 'This sentence is long enough to fill most of the budget on its own, really it is, honestly.';
    const parts = segmentSentences(`${long} No!`, { maxChars: long.length + 1, utterances: true });
    expect(parts.map((c) => c.text)).toEqual([long, 'No!']);
  });
});
