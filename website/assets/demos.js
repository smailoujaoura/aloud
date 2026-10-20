/* Pages in two languages, as Aloud reads them: each paragraph by a voice that speaks it. `audio` is
   assets/voices/<audio>.mp3 with its timings in <audio>.json (one entry per sentence, in order).
   The Italian story's audio was recorded from the extension in Chrome; the others were made by the
   extension sentence by sentence (website/README: making the demos). */
(() => {
  const V = {
    heart: { name: 'Heart', meta: 'Kokoro · US', portrait: 'kokoro-af_heart', voice: 'af_heart' },
    sara: { name: 'Sara', meta: 'Kokoro · IT', portrait: 'kokoro-if_sara', voice: 'if_sara' },
    doraEs: { name: 'Dora', meta: 'Kokoro · ES', portrait: 'kokoro-ef_dora', voice: 'ef_dora' },
    siwis: { name: 'Siwis', meta: 'Kokoro · FR', portrait: 'kokoro-ff_siwis', voice: 'ff_siwis' },
    alpha: { name: 'Alpha', meta: 'Kokoro · IN', portrait: 'kokoro-hf_alpha', voice: 'hf_alpha' },
    doraPt: { name: 'Dora', meta: 'Kokoro · BR', portrait: 'kokoro-pf_dora', voice: 'pf_dora' },
  };
  const LANG = { en: 'English', it: 'Italian', es: 'Spanish', fr: 'French', hi: 'Hindi', pt: 'Portuguese' };

  window.ALOUD_DEMOS = [
    { id: 'story', label: 'An Italian story', audio: 'bilingual', skipped: true,
      paragraphs: [
        { lang: 'it', who: V.sara, sentences: ["C'era una volta un pollo che si chiamava Pollo Piccolino.", 'Viveva in una fattoria insieme alla sua mamma e ai suoi fratelli.'] },
        { lang: 'en', who: V.heart, sentences: ['Once upon a time there was a chicken called Chicken Little.', 'He lived on a farm with his mother and his brothers.'] },
        { lang: 'it', who: V.sara, sentences: ['Un giorno una ghianda gli cadde sulla testa, e il pollo corse dalla volpe.'] },
      ] },
    { id: 'recipe', label: 'A Spanish recipe', audio: 'demo-recipe',
      paragraphs: [
        { lang: 'es', who: V.doraEs, sentences: ['La paella nació en los arrozales de Valencia.', 'Se cocina despacio, sin remover el arroz.'] },
        { lang: 'en', who: V.heart, sentences: ['Paella was born in the rice fields of Valencia.', 'It is cooked slowly, without stirring the rice.'] },
        { lang: 'es', who: V.doraEs, sentences: ['Al final, el arroz del fondo se tuesta: eso es el socarrat.'] },
      ] },
    { id: 'news', label: 'A French quote', audio: 'demo-news',
      paragraphs: [
        { lang: 'en', who: V.heart, sentences: ['At the press conference in Paris, the minister kept her answer short.'] },
        { lang: 'fr', who: V.siwis, sentences: ['Nous ne reculerons pas, et nous ne nous tairons pas.'] },
        { lang: 'en', who: V.heart, sentences: ['We will not back down, and we will not be silent, she said, and left the room.'] },
      ] },
    { id: 'proverbs', label: 'Hindi proverbs', audio: 'demo-proverbs',
      paragraphs: [
        { lang: 'hi', who: V.alpha, sentences: ['जहाँ चाह, वहाँ राह।'] },
        { lang: 'en', who: V.heart, sentences: ["Where there's a will, there's a way."] },
        { lang: 'hi', who: V.alpha, sentences: ['बूँद-बूँद से घड़ा भरता है।'] },
        { lang: 'en', who: V.heart, sentences: ['Drop by drop, the pot fills up.'] },
      ] },
    { id: 'travel', label: 'Notes from Rio', audio: 'demo-travel',
      paragraphs: [
        { lang: 'pt', who: V.doraPt, sentences: ['O Rio de Janeiro acorda cedo, com cheiro de café e de mar.'] },
        { lang: 'en', who: V.heart, sentences: ['Rio de Janeiro wakes up early, smelling of coffee and the sea.'] },
        { lang: 'pt', who: V.doraPt, sentences: ['À tarde, todo mundo vai para a praia.'] },
        { lang: 'en', who: V.heart, sentences: ['In the afternoon, everyone heads to the beach.'] },
      ] },
  ];
  window.ALOUD_LANG_NAMES = LANG;
})();
