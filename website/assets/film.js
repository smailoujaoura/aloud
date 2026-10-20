/* The video-speed showcase's film: a short story told by Aloud's voices over an animated sea.
   Each line has its voice and the scene it plays over; the audio is assets/voices/film.mp3 with
   timings in film.json (made by the extension, line by line). */
(() => {
  const narrator = { voice: 'bm_george', name: 'George' };
  const sailor = { voice: 'am_fenrir', name: 'Fenrir' };
  window.ALOUD_FILM = [
    { scene: 'calm', who: narrator, text: 'The Grey Gannet left harbour at dawn, with eleven sailors and a hold full of salt.' },
    { scene: 'storm', who: narrator, text: 'On the fourth night, the barometer fell faster than anyone had ever seen.' },
    { scene: 'storm', who: sailor, text: 'Captain! The mast is cracking!' },
    { scene: 'fog', who: narrator, text: 'By morning the storm was gone, but a thick white fog had taken its place.' },
    { scene: 'fog', who: sailor, text: "That's no ship's bell. That's a lighthouse." },
    { scene: 'dawn', who: narrator, text: 'And through the fog a single light turned, and showed them the way home.' },
  ];
})();
