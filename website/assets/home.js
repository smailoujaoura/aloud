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
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
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
  // The extension's own speeds, 0.5× to 4×, in a menu over the bar.
  const speedMenu = document.createElement('div');
  speedMenu.className = 'speed-menu';
  speedMenu.setAttribute('role', 'menu');
  speedMenu.hidden = true;
  const label = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(r)) + '×';
  const wpmAt = (r) => Math.round((BASE_WPM * r) / 5) * 5;
  const setRate = (r) => {
    audio.playbackRate = r;
    speedBtn.textContent = label(r) + ' · ' + wpmAt(r) + ' wpm';
    speedBtn.setAttribute('aria-label', 'Reading speed: ' + r + '×. Change speed');
    for (const b of speedMenu.children) b.setAttribute('aria-checked', String(Number(b.dataset.rate) === r));
  };
  for (const r of RATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.dataset.rate = String(r);
    b.innerHTML = '<b>' + label(r) + '</b><span>' + wpmAt(r) + ' wpm</span>';
    b.addEventListener('click', () => { setRate(r); speedMenu.hidden = true; });
    speedMenu.append(b);
  }
  speedBtn.closest('.bar').append(speedMenu);
  speedBtn.setAttribute('aria-haspopup', 'menu');
  speedBtn.addEventListener('click', (e) => { e.stopPropagation(); speedMenu.hidden = !speedMenu.hidden; });
  document.addEventListener('click', (e) => { if (!speedMenu.contains(e.target)) speedMenu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') speedMenu.hidden = true; });
  setRate(1);
  for (const b of document.querySelectorAll('[data-hear]')) {
    b.addEventListener('click', () => {
      document.getElementById('demo').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      play();
    });
  }

  // ---- Pages in two languages: a tab per demo, the page, the board, and the voices switching.
  {
    const demos = window.ALOUD_DEMOS;
    const NAMES = window.ALOUD_LANG_NAMES;
    const tabsEl = document.getElementById('demo-tabs');
    const pageEl = document.getElementById('lang-page');
    const board = document.getElementById('lang-board');
    const btn = document.getElementById('lang-play');
    const label = btn.querySelector('span');
    const glyph = btn.querySelector('svg');
    const showPlaying = (on) => { glyph.innerHTML = on ? PAUSE : PLAY; label.textContent = on ? 'Pause' : 'Hear it switch voices'; };
    const story = new Audio();
    story.preload = 'none';
    let demo = null;
    let timing = null;
    let spans = [];
    let raf = 0;
    const clear = () => {
      for (const s of spans) s.classList.remove('on');
      for (const p of pageEl.querySelectorAll('.lp')) p.classList.remove('on');
      for (const r of board.querySelectorAll('.row')) r.classList.remove('on');
      board.classList.remove('live');
    };
    const stop = () => { cancelAnimationFrame(raf); clear(); showPlaying(false); };
    const paint = () => {
      if (!timing) return;
      const t = story.currentTime;
      const i = timing.sentences.findIndex((x) => t >= x.start && t < x.end + 0.25);
      spans.forEach((s, n) => s.classList.toggle('on', n === i));
      const para = i >= 0 ? spans[i].closest('.lp') : null;
      for (const p of pageEl.querySelectorAll('.lp')) p.classList.toggle('on', p === para);
      const lang = i >= 0 ? timing.sentences[i].lang : '';
      board.classList.toggle('live', !!lang);
      for (const r of board.querySelectorAll('.row')) r.classList.toggle('on', r.dataset.lang === lang);
      if (!story.paused) raf = requestAnimationFrame(paint);
    };
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const render = (d) => {
      pageEl.replaceChildren();
      spans = [];
      // A translation reads as one (quieter, in italics); a quote inside an English report does not.
      const translations = d.id !== 'news';
      for (const p of d.paragraphs) {
        const para = el('p', 'lp' + (translations && p.lang === 'en' ? ' en' : ''));
        para.lang = p.lang;
        para.dataset.lang = p.lang;
        const who = el('span', 'who');
        const img = el('img');
        img.src = 'assets/portraits/' + p.who.portrait + '.webp';
        img.alt = '';
        who.append(img, el('b', null, p.lang.toUpperCase()));
        para.append(who);
        p.sentences.forEach((text, n) => {
          if (n) para.append(' ');
          const s = el('span', 's', text);
          spans.push(s);
          para.append(s);
        });
        pageEl.append(para);
      }
      if (d.skipped) {
        const skip = el('p', 'skipped');
        skip.append(el('s', null, 'Translate?'), ' a button, and a translation still folded away: not read');
        pageEl.append(skip);
      }
      board.replaceChildren();
      const seen = new Map();
      for (const p of d.paragraphs) if (!seen.has(p.lang)) seen.set(p.lang, p.who);
      for (const [lang, who] of seen) {
        const row = el('div', 'row');
        row.dataset.lang = lang;
        const name = el('span', 'lang', NAMES[lang] ?? lang);
        name.append(el('small', null, 'auto'));
        const wire = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        wire.setAttribute('viewBox', '0 0 64 36');
        wire.setAttribute('aria-hidden', 'true');
        wire.innerHTML = '<path d="M2 18 C 30 18, 34 18, 62 18"/>';
        const w = el('span', 'who');
        const img = el('img');
        img.src = 'assets/portraits/' + who.portrait + '.webp';
        img.alt = '';
        const txt = el('span', null, who.name);
        txt.append(el('small', null, who.meta));
        w.append(img, txt);
        row.append(name, wire, w);
        board.append(row);
      }
    };
    const select = (i) => {
      if (!story.paused) story.pause();
      stop();
      demo = demos[i];
      timing = null;
      story.removeAttribute('src');
      [...tabsEl.children].forEach((t, n) => { t.setAttribute('aria-selected', String(n === i)); t.tabIndex = n === i ? 0 : -1; });
      const tab = tabsEl.children[i];
      if (tab && tabsEl.scrollWidth > tabsEl.clientWidth) tabsEl.scrollLeft = tab.offsetLeft - (tabsEl.clientWidth - tab.offsetWidth) / 2;
      render(demo);
    };
    demos.forEach((d, i) => {
      const t = el('button', null, d.label);
      t.type = 'button';
      t.setAttribute('role', 'tab');
      t.addEventListener('click', () => select(i));
      tabsEl.append(t);
    });
    story.addEventListener('ended', stop);
    btn.addEventListener('click', async () => {
      if (!story.paused) { story.pause(); stop(); return; }
      claim(story, stop);
      const mine = demo;
      timing ??= await fetch('assets/voices/' + demo.audio + '.json').then((r) => r.json()).catch(() => null);
      if (mine !== demo) return;
      if (!story.getAttribute('src')) story.src = 'assets/voices/' + demo.audio + '.mp3';
      showPlaying(true);
      try { await story.play(); paint(); } catch { stop(); }
    });
    select(0);
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
  const voice = new Audio();
  let playing = null;
  let turn = 0;
  // What the voice is saying, in a speech bubble over its face.
  let bubble = null;
  const idle = () => {
    playing?.classList.remove('playing');
    playing = null;
    bubble?.remove();
    bubble = null;
  };
  const speak = (b, v) => {
    bubble?.remove();
    bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.setAttribute('role', 'status');
    const [line, english] = (v.line ?? '').split(' / ');
    bubble.append(line ? '“' + line + '”' : "Piper's own sample of this voice");
    if (english) { const tr = document.createElement('span'); tr.className = 'tr'; tr.textContent = english; bubble.append(tr); }
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = v.name + ' · ' + v.meta;
    bubble.append(who);
    wall.append(bubble);
    // Above the face, kept inside the grid, with its tail pointing at the face.
    const w = bubble.offsetWidth;
    const center = b.offsetLeft + b.offsetWidth / 2;
    const left = Math.max(0, Math.min(wall.clientWidth - w, center - w / 2));
    bubble.style.left = left + 'px';
    bubble.style.top = b.offsetTop - bubble.offsetHeight - 10 + 'px';
    bubble.style.setProperty('--tail', Math.max(18, Math.min(w - 18, center - left)) + 'px');
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
      speak(b, v);
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
    // The whole list, drawn again from scratch: pressing twice can never add a voice twice.
    moreBtn.onclick = () => { wall.replaceChildren(...all.map(face)); moreRow.hidden = true; };
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
})();
