/* The video-speed showcase's film: a short story told by Aloud's voices over painted scenes.
   Each line has its speaker and the scene it plays over; the audio is assets/voices/film.mp3 with
   timings in film.json (made by the extension, line by line). The two sailors are Supertonic voices
   set to French and Russian, reading English: the accent is the model's own. */
(() => {
  const narrator = { name: 'Narrator', engine: 'kokoro', voice: 'bm_george', credit: 'George (Kokoro)' };
  const captain = { name: 'Captain', engine: 'kokoro', voice: 'am_santa', credit: 'Santa (Kokoro)' };
  const pierre = { name: 'Pierre', engine: 'supertonic', voice: 'M1@fr', credit: 'Male 1 in French (Supertonic)' };
  const dmitri = { name: 'Dmitri', engine: 'supertonic', voice: 'M5@ru', credit: 'Male 5 in Russian (Supertonic)' };
  window.ALOUD_FILM = [
    { scene: 'calm', who: narrator, text: 'The Grey Gannet left harbour at dawn, with eleven sailors and a hold full of salt.' },
    { scene: 'galley', who: pierre, text: 'Dmitri, this soup is a crime against France.' },
    { scene: 'galley', who: dmitri, text: 'In Russia, we call this soup a luxury.' },
    { scene: 'storm', who: narrator, text: 'On the fourth night, the barometer fell faster than anyone had ever seen.' },
    { scene: 'storm', who: pierre, text: 'Captain! The mast is cracking!' },
    { scene: 'storm', who: captain, text: 'Then hold it together, lads! With your bare hands!' },
    { scene: 'storm', who: dmitri, text: 'Is fine. Is only a little bit broken.' },
    { scene: 'fog', who: narrator, text: 'By morning the storm was gone, but a thick white fog had taken its place.' },
    { scene: 'fog', who: pierre, text: 'Listen. A bell.' },
    { scene: 'fog', who: dmitri, text: 'That is no bell, my friend. That is a lighthouse.' },
    { scene: 'dawn', who: narrator, text: 'And through the fog a single light turned, and showed them the way home.' },
    { scene: 'dawn', who: pierre, text: 'Dmitri. I take back what I said about the soup.' },
  ];
})();
