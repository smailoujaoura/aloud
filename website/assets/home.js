(() => {
  // ---- One player for the whole page: hearing a voice stops the demo, and the other way round.
  let current = null;
  const claim = (audio, onStop) => {
    if (current && current.audio !== audio) { current.audio.pause(); current.onStop(); }
    current = { audio, onStop };
  };

  // ---- The hero demo: Alba reading the article, with Piper's own word timings.
  const sentences = [...document.querySelectorAll('#demo-text .s')];
  const status = document.getElementById('demo-status');
  const fill = document.getElementById('demo-fill');
  const playBtn = document.getElementById('demo-play');
  const icon = document.getElementById('demo-play-icon');
  const speedBtn = document.getElementById('demo-speed');
  const PAUSE = '<path d="M4 2.5h3v11H4z"/><path d="M9 2.5h3v11H9z"/>';
  const PLAY = '<path d="M4 2.5v11l9-5.5z"/>';
  const RATES = [1, 1.25, 1.5, 0.85];
  const BASE_WPM = 185;
  const audio = new Audio();
  // The whole file, held in memory: seeking (previous, next) then works on any host, including
  // ones that do not answer range requests. It is 130 KB.
  let loaded = null;
  const load = () => (loaded ??= fetch('assets/voices/demo.mp3')
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
    .then((b) => { audio.src = URL.createObjectURL(b); })
    .catch((e) => { loaded = null; throw e; }));
  let timing = null;
  let words = [];
  let rate = 0;
  let frame = 0;

  const say = (text, call = false) => { status.textContent = text; status.classList.toggle('call', call); };

  // Wrap each timed word in a span, in order, inside its sentence.
  const timed = fetch('assets/voices/demo.json').then((r) => r.json()).then((t) => {
    timing = t;
    words = t.sentences.map((s, i) => {
      const el = sentences[i];
      const text = el.textContent;
      el.textContent = '';
      let at = 0;
      const spans = [];
      for (const w of s.words) {
        const k = text.indexOf(w.word, at);
        if (k < 0) continue;
        el.append(text.slice(at, k));
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = w.word;
        el.append(span);
        spans.push({ span, start: w.start, end: w.end });
        at = k + w.word.length;
      }
      el.append(text.slice(at));
      return spans;
    });
  }).catch(() => null);

  function paint() {
    if (!timing) return;
    const t = audio.currentTime;
    const si = Math.max(0, timing.sentences.findLastIndex((s) => t >= s.start - 0.05));
    sentences.forEach((s, i) => s.classList.toggle('on', i === si && (t > 0 || !audio.paused)));
    for (const ws of words) for (const w of ws) w.span.classList.toggle('on', !audio.paused && t >= w.start && t < w.end + 0.06);
    fill.style.width = Math.min(100, (t / timing.duration) * 100) + '%';
    if (!audio.paused) say('Alba · sentence ' + (si + 1) + ' of ' + sentences.length);
  }
  function loop() { paint(); if (!audio.paused) frame = requestAnimationFrame(loop); }
  const stopped = () => { icon.innerHTML = PLAY; playBtn.setAttribute('aria-label', 'Play'); cancelAnimationFrame(frame); paint(); };

  async function play() {
    say('Loading Alba…');
    try { await Promise.all([timed, load()]); } catch { say('Could not load the audio. Try again', true); return; }
    claim(audio, stopped);
    if (audio.ended || (timing && audio.currentTime >= timing.duration - 0.05)) audio.currentTime = 0;
    try { await audio.play(); } catch { say('Press play to hear Alba read this', true); return; }
    icon.innerHTML = PAUSE; playBtn.setAttribute('aria-label', 'Pause');
    loop();
  }
  function pause() { audio.pause(); say('Paused'); stopped(); }
  function jump(d) {
    if (!timing || !audio.src) return;
    const t = audio.currentTime;
    const si = Math.max(0, timing.sentences.findLastIndex((s) => t >= s.start - 0.05));
    const to = Math.min(timing.sentences.length - 1, Math.max(0, si + d));
    audio.currentTime = timing.sentences[to].start;
    paint();
    if (audio.paused) say('Sentence ' + (to + 1) + ' of ' + sentences.length);
  }

  audio.addEventListener('ended', () => { stopped(); say('Finished. Press play to hear it again'); });
  playBtn.addEventListener('click', () => (audio.paused ? play() : pause()));
  status.addEventListener('click', () => { if (status.classList.contains('call')) play(); });
  document.getElementById('demo-prev').addEventListener('click', () => jump(-1));
  document.getElementById('demo-next').addEventListener('click', () => jump(1));
  speedBtn.addEventListener('click', () => {
    rate = (rate + 1) % RATES.length;
    const r = RATES[rate];
    audio.playbackRate = r;
    const wpm = Math.round((BASE_WPM * r) / 5) * 5;
    // 1 → "1.0×", 1.25 → "1.25×", 1.5 → "1.5×", 0.85 → "0.85×".
    speedBtn.textContent = (Number.isInteger(r) ? r.toFixed(1) : String(r)) + '× · ' + wpm + ' wpm';
    speedBtn.setAttribute('aria-label', 'Reading speed: ' + r + '×. Change speed');
  });
  for (const b of document.querySelectorAll('[data-hear]')) {
    b.addEventListener('click', () => {
      document.getElementById('demo').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      play();
    });
  }

  // ---- Two languages, two voices: the story as Aloud read it, Italian by Sara, English by Heart.
  {
    const btn = document.getElementById('lang-play');
    const label = btn.querySelector('span');
    const glyph = btn.querySelector('svg');
    const showPlaying = (on) => { glyph.innerHTML = on ? PAUSE : PLAY; label.textContent = on ? 'Pause' : 'Hear it switch voices'; };
    const board = document.getElementById('lang-board');
    const spans = [...document.querySelectorAll('#lang-page .s')];
    const rows = [...board.querySelectorAll('.row')];
    const paras = [...document.querySelectorAll('#lang-page .lp')];
    const story = new Audio();
    story.preload = 'none';
    let timing = null;
    let raf = 0;
    const clear = () => {
      for (const s of spans) s.classList.remove('on');
      for (const p of paras) p.classList.remove('on');
      for (const r of rows) r.classList.remove('on');
      board.classList.remove('live');
    };
    const stop = () => { cancelAnimationFrame(raf); clear(); showPlaying(false); };
    const paint = () => {
      if (!timing) return;
      const t = story.currentTime;
      const i = timing.sentences.findIndex((x) => t >= x.start && t < x.end + 0.25);
      spans.forEach((s, n) => s.classList.toggle('on', n === i));
      const para = i >= 0 ? spans[i].closest('.lp') : null;
      paras.forEach((p) => p.classList.toggle('on', p === para));
      const lang = i >= 0 ? timing.sentences[i].lang : '';
      board.classList.toggle('live', !!lang);
      rows.forEach((r) => r.classList.toggle('on', r.dataset.lang === lang));
      if (!story.paused) raf = requestAnimationFrame(paint);
    };
    story.addEventListener('ended', stop);
    btn.addEventListener('click', async () => {
      if (!story.paused) { story.pause(); stop(); return; }
      claim(story, stop);
      timing ??= await fetch('assets/voices/bilingual.json').then((r) => r.json()).catch(() => null);
      if (!story.src) story.src = 'assets/voices/bilingual.mp3';
      showPlaying(true);
      try { await story.play(); paint(); } catch { stop(); }
    });
  }

  // ---- Firefox WebGPU steps: a link that opens them, and buttons that copy the setting names.
  const openSteps = (id) => {
    const steps = document.getElementById(id);
    if (!steps) return;
    for (let d = steps; d; d = d.parentElement?.closest('details')) d.open = true;
    steps.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  for (const a of document.querySelectorAll('[data-open]')) {
    a.addEventListener('click', (e) => { e.preventDefault(); openSteps(a.dataset.open); history.replaceState(null, '', '#' + a.dataset.open); });
  }
  if (location.hash === '#firefox-webgpu') openSteps('firefox-webgpu');
  for (const b of document.querySelectorAll('.copy[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
      catch { b.textContent = 'Select it above'; }
      setTimeout(() => (b.textContent = 'Copy'), 1600);
    });
  }


  // ---- Voices by language: a tab per language, every face plays its own clip.
  const tabs = document.getElementById('voice-tabs');
  const wall = document.getElementById('faces');
  const quote = document.getElementById('quote');
  const voice = new Audio();
  let playing = null;
  let turn = 0;
  const IDLE = 'Click a face to hear that voice.';
  const idle = () => {
    playing?.classList.remove('playing');
    playing = null;
    quote.classList.add('idle');
    quote.textContent = IDLE;
  };
  voice.addEventListener('ended', idle);
  const PLAY_SVG = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const face = (v) => {
    const b = document.createElement('button');
    b.className = 'face';
    b.type = 'button';
    b.setAttribute('aria-label', 'Hear ' + v.name + ', ' + v.meta);
    const ring = document.createElement('span');
    ring.className = 'ring';
    if (v.portrait) {
      const img = document.createElement('img');
      img.src = 'assets/portraits/' + v.portrait + '.webp';
      img.alt = '';
      img.loading = 'lazy';
      ring.append(img);
    } else {
      const i = document.createElement('span');
      i.className = 'initial';
      i.textContent = v.name.slice(0, 1);
      ring.append(i);
    }
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.innerHTML = PLAY_SVG + '<span class="eq"><i></i><i></i><i></i></span>';
    ring.append(badge);
    const name = document.createElement('span');
    name.className = 'name';
    name.append(v.name);
    const small = document.createElement('small');
    small.textContent = v.meta;
    name.append(small);
    b.append(ring, name);
    b.addEventListener('click', async () => {
      if (playing === b) { turn++; voice.pause(); idle(); return; }
      claim(voice, idle);
      playing?.classList.remove('playing');
      playing = b;
      b.classList.add('playing');
      quote.classList.remove('idle');
      quote.innerHTML = '';
      quote.append(v.line ? '“' + v.line + '”' : "Piper's own sample of this voice");
      const tag = document.createElement('span');
      tag.className = 'who';
      tag.textContent = v.name + ' · ' + v.meta;
      quote.append(tag);
      voice.src = 'assets/voices/' + v.file + '.mp3';
      // Only the latest click may reset the wall: switching voices quickly rejects the earlier
      // play(), and its catch used to clear the face that is playing now.
      const mine = ++turn;
      try { await voice.play(); } catch { if (mine === turn) idle(); }
    });
    return b;
  };
  const show = (i) => {
    [...tabs.children].forEach((t, n) => { t.setAttribute('aria-selected', String(n === i)); t.tabIndex = n === i ? 0 : -1; });
    if (playing) { turn++; voice.pause(); idle(); }
    const all = window.ALOUD_VOICES[i].voices;
    // A long list starts with its first twenty, and the rest a click away.
    const FIRST = 20;
    wall.replaceChildren(...all.slice(0, FIRST).map(face));
    moreRow.hidden = all.length <= FIRST;
    moreBtn.textContent = 'Show all ' + all.length + ' voices';
    moreBtn.onclick = () => { wall.append(...all.slice(FIRST).map(face)); moreRow.hidden = true; };
    const tab = tabs.children[i];
    // Keep the chosen tab in view in the row that scrolls sideways on a phone, without moving the page.
    if (tab && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = tab.offsetLeft - (tabs.clientWidth - tab.offsetWidth) / 2;
  };
  const moreRow = document.getElementById('show-all');
  const moreBtn = moreRow.querySelector('button');
  window.ALOUD_VOICES.forEach((group, i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.setAttribute('role', 'tab');
    t.lang = group.code;
    t.append(group.label);
    const n = document.createElement('small');
    n.textContent = group.voices.length;
    t.append(n);
    t.addEventListener('click', () => show(i));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const all = [...tabs.children];
      const next = (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
      all[next].focus();
      show(next);
    });
    tabs.append(t);
  });
  show(0);
})();

(() => {
  // Once the stores are live: point the main button at this browser's store, and mark its card.
  if (document.body.dataset.stores !== 'live') {
    // Not listed yet: the cards say so, and lead nowhere.
    for (const card of document.querySelectorAll('.store')) card.removeAttribute('href');
    return;
  }
  const ua = navigator.userAgent;
  const store = /Firefox\//.test(ua) ? (/Android/.test(ua) ? 'android' : 'firefox')
    : /Chrome\//.test(ua) && !/Mobile/.test(ua) ? 'chrome' : null;
  if (!store) return;
  const card = document.querySelector('.store[data-store="' + store + '"]');
  card.classList.add('mine');
  let label = card.querySelector('.btn').textContent;
  if (store === 'chrome') {
    const name = navigator.brave ? 'Brave' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Vivaldi/.test(ua) ? 'Vivaldi' : 'Chrome';
    label = 'Add to ' + name;
    card.querySelector('.btn').textContent = label;
  }
  const hero = document.getElementById('hero-install');
  hero.href = card.href;
  hero.textContent = label + ', free';
  document.getElementById('hero-browsers').innerHTML = 'Also on <a href="#install">other browsers</a>';
})();
