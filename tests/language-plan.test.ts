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

  it('trusts a local lang attribute over the detector', async () => {
    const plan = await planLanguages([p('Once upon a time there was a chicken.', 'it-IT')], detector, 'en');
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
