import { describe, it, expect, vi } from 'vitest';
import { planLanguages, scriptLanguage, type Detector } from '@/content/language-plan';

/** A stand-in for the browser's detector: Italian and English by a few words, unreliable when short. */
const detector: Detector = async (text) => {
  const t = text.toLowerCase();
  const reliable = t.split(/\s+/).length >= 4;
  if (/\b(il|la|che|una|di|era|volpe|pollo)\b/.test(t)) return { language: 'it', reliable };
  if (/\b(the|and|was|of|fox|chicken)\b/.test(t)) return { language: 'en', reliable };
  return { language: 'und', reliable: false };
};

const p = (text: string, markup = '') => ({ text, markup });

describe('planLanguages', () => {
  it('alternates Italian and English paragraphs without merging them', async () => {
    const plan = await planLanguages(
      [
        p("C'era una volta un pollo che si chiamava Pollo Piccolino."),
        p('Once upon a time there was a chicken called Chicken Little.'),
        p('Un giorno la volpe chiese che cosa fosse successo.'),
      ],
      detector,
      'en',
    );
    expect(plan.map((l) => l.language)).toEqual(['it', 'en', 'it']);
    expect(plan.every((l) => l.source === 'detected')).toBe(true);
  });

  it('keeps a short reply in the language of the conversation around it', async () => {
    const plan = await planLanguages(
      [
        p('La volpe chiese che cosa fosse successo, e il pollo rispose:'),
        p('No!'),
        p('Il pollo corse via dalla volpe e dalla sua tana.'),
      ],
      detector,
      'en',
    );
    expect(plan.map((l) => l.language)).toEqual(['it', 'it', 'it']);
    expect(plan[1]!.source).toBe('context');
  });

  it('does not switch for a short passage the detector calls something else between two that agree', async () => {
    const detect: Detector = async (text) =>
      text === 'Chicken Little!' ? { language: 'en', reliable: true } : { language: 'it', reliable: true };
    const plan = await planLanguages(
      [p('Il pollo corse via dalla volpe e dalla sua tana, spaventato.'), p('Chicken Little!'), p('Il pollo tornò a casa dalla mamma, finalmente.')],
      detect,
      'it',
    );
    expect(plan.map((l) => l.language)).toEqual(['it', 'it', 'it']);
  });

  it('keeps a short translation in its own language: it is a sentence, not an exclamation', async () => {
    const plan = await planLanguages(
      [p('Lasciate che vi racconti la storia di un pollo.'), p('Let me tell you the story of a chicken.'), p("C'era una volta un pollo.")],
      detector,
      'it',
    );
    expect(plan.map((l) => l.language)).toEqual(['it', 'en', 'it']);
  });

  it('uses the detector’s unreliable answer for a real sentence, not for a repeated exclamation', async () => {
    // What Chromium's CLD answers for these (measured): right on sentences, wrong on the rest.
    const cld: Record<string, { language: string; reliable: boolean }> = {
      'Let me tell you a story about a chicken.': { language: 'en', reliable: false },
      'Lasciate che vi racconti la storia di un pollo.': { language: 'it', reliable: false },
      '"No! No! No! Go away! Go away!"': { language: 'pt', reliable: false },
      'La volpe chiese che cosa fosse successo, e il pollo rispose:': { language: 'it', reliable: true },
      'Il pollo corse via dalla volpe, ma la volpe lo seguì.': { language: 'it', reliable: true },
    };
    const detect: Detector = async (t) => cld[t] ?? null;
    const plan = await planLanguages(Object.keys(cld).map((t) => p(t)), detect, 'it');
    expect(plan.map((l) => l.language)).toEqual(['en', 'it', 'it', 'it', 'it']);
    expect(plan[2]!.source).toBe('context');
  });

  it('a Chinese paragraph between English ones keeps its language: it is not a "short" reply', async () => {
    const zh = '我们今天去公园散步。天气很好，孩子们在草地上玩。';
    const detect: Detector = async (t) => (t === zh ? { language: 'zh', reliable: true } : { language: 'en', reliable: true });
    const plan = await planLanguages(
      [p('The children went to the park in the morning.'), p(zh), p('They came home late in the afternoon.')],
      detect,
      'en',
    );
    expect(plan.map((l) => l.language)).toEqual(['en', 'zh', 'en']);
  });

  it('trusts a local lang attribute over the detector', async () => {
    const plan = await planLanguages([p('Once upon a time there was a chicken.', 'it-IT')], detector, 'en');
    expect(plan[0]).toEqual({ language: 'it', source: 'markup' });
  });

  it("reads a site's own words in a block marked as another language in the page's language", async () => {
    // A Google result: the block is lang="it"; Google's own link inside it is English.
    const google: Detector = async (text) =>
      /translate this page/i.test(text) ? { language: 'en', reliable: false } : { language: 'it', reliable: true };
    const plan = await planLanguages(
      [p('Permesso di soggiorno | Polizia di Stato - Questura', 'it'), p('Translate this page', 'it'), p('Inserisci il numero di pratica della richiesta del tuo permesso di soggiorno', 'it'), p('Wikipedia', 'it')],
      google,
      'it',
      new Map(),
      'en',
    );
    expect(plan.map((l) => l.language)).toEqual(['it', 'en', 'it', 'it']);
  });

  it('keeps a marked block when the detector names anything but the page’s declared language', async () => {
    const french: Detector = async () => ({ language: 'fr', reliable: true });
    const plan = await planLanguages([p('Ciao, come stai oggi amico mio?', 'it')], french, 'en', new Map(), 'en');
    expect(plan[0]).toEqual({ language: 'it', source: 'markup' });
  });

  it('falls back to the page language when nothing can tell, and says so', async () => {
    const plan = await planLanguages([p('42'), p('—')], detector, 'fr-FR');
    expect(plan).toEqual([
      { language: 'fr', source: 'page' },
      { language: 'fr', source: 'page' },
    ]);
  });

  it('a title before the first paragraph takes the language of what follows', async () => {
    const plan = await planLanguages([p('Pollo'), p("C'era una volta un pollo che si chiamava Pollo Piccolino.")], detector, 'en');
    expect(plan.map((l) => l.language)).toEqual(['it', 'it']);
  });

  it('asks the detector once per distinct text, and reuses the cache', async () => {
    const detect = vi.fn(detector);
    const cache = new Map();
    const passages = [p('Il pollo corse via dalla volpe.'), p('Il pollo corse via dalla volpe.')];
    await planLanguages(passages, detect, 'en', cache);
    await planLanguages(passages, detect, 'en', cache);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('survives a detector that throws', async () => {
    const plan = await planLanguages([p('Il pollo corse via dalla volpe.')], async () => Promise.reject(new Error('no')), 'it');
    expect(plan[0]!.language).toBe('it');
  });

  it('uses a writing system only one language has', async () => {
    expect(scriptLanguage('안녕하세요 세계')).toBe('ko');
    expect(scriptLanguage('こんにちは、世界')).toBe('ja');
    expect(scriptLanguage('Καλημέρα κόσμε')).toBe('el');
    expect(scriptLanguage('你好世界')).toBe('zh');
    expect(scriptLanguage('Привет мир')).toBe('');
    const plan = await planLanguages([p('Καλημέρα σε όλους')], async () => null, 'en');
    expect(plan[0]).toEqual({ language: 'el', source: 'script' });
  });
});

describe('a short selection', () => {
  /** The browser's detector on a few words: an answer, never a reliable one, often wrong. */
  const short: Detector = async (text) => {
    const answers: Record<string, string> = { 'bordereau de change': 'fr', 'student housing': 'ko', 'merci beaucoup': 'sr' };
    return { language: answers[text] ?? 'und', reliable: false };
  };

  it('takes an unsure answer that names a language the reader reads, in its own alphabet', async () => {
    const plan = await planLanguages([p('bordereau de change')], short, 'en', new Map(), 'en', new Set(['en', 'fr']));
    expect(plan[0]).toEqual({ language: 'fr', source: 'detected' });
  });

  it('keeps the page language when the language is not one the reader reads', async () => {
    const plan = await planLanguages([p('merci beaucoup')], short, 'en', new Map(), 'en', new Set(['en', 'it']));
    expect(plan[0]!.language).toBe('en');
  });

  it('never takes a language whose alphabet the words are not written in', async () => {
    const plan = await planLanguages([p('student housing')], short, 'en', new Map(), 'en', new Set(['en', 'ko']));
    expect(plan[0]!.language).toBe('en');
  });

  it('a page (no familiar languages given) is unchanged', async () => {
    const plan = await planLanguages([p('bordereau de change')], short, 'en', new Map(), 'en');
    expect(plan[0]!.language).toBe('en');
  });
});
