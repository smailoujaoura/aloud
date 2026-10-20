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
  // One button, four speeds: 1×, 2×, 4×, then 0.5×, and round again.
  const RATES = [1, 2, 4, 0.5];
  const BASE_WPM = 185;
  let rateAt = 0;
  const label = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(r)) + '×';
  const setRate = (r) => {
    audio.playbackRate = r;
    speedBtn.textContent = label(r) + ' · ' + Math.round((BASE_WPM * r) / 5) * 5 + ' wpm';
    speedBtn.setAttribute('aria-label', 'Reading speed: ' + r + '×. Change speed');
  };
  speedBtn.addEventListener('click', () => { rateAt = (rateAt + 1) % RATES.length; setRate(RATES[rateAt]); });
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

(() => {
  // ---- Notes, shown working: the page plays it once it is in view, then it is yours to try.
  const demo = document.getElementById('note-demo');
  if (!demo) return;
  const page = document.getElementById('note-page');
  const bar = document.getElementById('note-toolbar');
  const pop = document.getElementById('note-pop');
  const field = document.getElementById('np-text');
  const tags = document.getElementById('np-tags');
  const tagField = document.getElementById('np-tag');
  const list = document.getElementById('note-list');
  const pointer = document.getElementById('note-pointer');
  const replay = document.getElementById('note-replay');
  const original = page.innerHTML;
  let pending = null;
  let run = 0;
  let next = 1;
  const notes = new Map();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const b of bar.querySelectorAll('button[data-c]')) b.style.setProperty('--c', b.dataset.c);

  // ---- the list beside the page
  const renderList = () => {
    list.replaceChildren();
    const marks = [...page.querySelectorAll('mark[data-note]')];
    if (!marks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Your highlights appear here.';
      list.append(li);
      return;
    }
    for (const m of marks) {
      const info = notes.get(m.dataset.note) ?? {};
      const li = document.createElement('li');
      li.style.setProperty('--c', m.style.getPropertyValue('--c'));
      li.append(m.textContent);
      if (info.comment) { const c = document.createElement('small'); c.textContent = info.comment; li.append(c); }
      if (info.tags?.length) { const t = document.createElement('span'); t.className = 'tags'; for (const tag of info.tags) { const x = document.createElement('span'); x.textContent = '#' + tag; t.append(x); } li.append(t); }
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove this highlight');
      x.addEventListener('click', () => { m.replaceWith(...m.childNodes); page.normalize(); renderList(); });
      li.append(x);
      list.append(li);
    }
  };

  // ---- placing things over the page
  const rel = (r) => { const box = demo.getBoundingClientRect(); return { left: r.left - box.left, top: r.top - box.top, right: r.right - box.left, bottom: r.bottom - box.top, width: r.width, height: r.height }; };
  const placeBar = (range) => {
    const r = rel(range.getBoundingClientRect());
    bar.hidden = false;
    bar.style.left = Math.max(0, Math.min(demo.clientWidth - bar.offsetWidth, r.left + r.width / 2 - bar.offsetWidth / 2)) + 'px';
    bar.style.top = Math.max(0, r.top - bar.offsetHeight - 8) + 'px';
  };
  const placePop = (mark) => {
    const r = rel(mark.getBoundingClientRect());
    pop.hidden = false;
    pop.style.left = Math.max(0, Math.min(demo.clientWidth - pop.offsetWidth, r.left)) + 'px';
    pop.style.top = r.bottom + 8 + 'px';
  };
  const hideBar = () => { bar.hidden = true; pending = null; };
  const point = async (target, dx = 0.5, dy = 0.5) => {
    const r = rel(target.getBoundingClientRect());
    pointer.classList.add('on');
    pointer.style.transform = `translate(${r.left + r.width * dx}px, ${r.top + r.height * dy}px)`;
    await wait(700);
  };
  const press = async (button) => { await point(button); button.classList.add('press'); await wait(220); button.classList.remove('press'); };

  // ---- marking
  const mark = (range, { color, underline }) => {
    const m = document.createElement('mark');
    m.className = (underline ? 'ul' : 'hl') + ' fresh';
    m.style.setProperty('--c', color);
    m.dataset.note = String(next++);
    m.append(range.extractContents());
    range.insertNode(m);
    for (const inner of m.querySelectorAll('mark')) inner.replaceWith(...inner.childNodes);
    getSelection().removeAllRanges();
    hideBar();
    notes.set(m.dataset.note, {});
    renderList();
    return m;
  };

  // ---- the performance
  const selectWords = async (span, mine) => {
    const text = span.firstChild;
    const ends = [...text.data.matchAll(/\S+/g)].map((w) => w.index + w[0].length);
    const range = document.createRange();
    range.setStart(text, 0);
    await point(span, 0, 0.6);
    for (const end of ends) {
      if (mine !== run) return null;
      range.setEnd(text, end);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      pointer.style.transform = `translate(${rel(range.getBoundingClientRect()).right}px, ${rel(range.getBoundingClientRect()).bottom - 8}px)`;
      await wait(110);
    }
    await wait(250);
    placeBar(range);
    pending = range.cloneRange();
    await wait(500);
    return range;
  };
  const type = async (el, text, mine) => {
    el.classList.add('typing');
    for (const ch of text) { if (mine !== run) return; el.textContent += ch; await wait(42); }
    el.classList.remove('typing');
  };
  const play = async () => {
    const mine = ++run;
    replay.hidden = true;
    page.innerHTML = original;
    notes.clear();
    renderList();
    pop.hidden = true;
    hideBar();
    const ph = (id) => page.querySelector(`[data-ph="${id}"]`);
    // 1. A passage, highlighted yellow.
    if (!(await selectWords(ph('a'), mine))) return;
    await press(bar.querySelector('[aria-label="Yellow"]'));
    if (mine !== run) return;
    mark(pending, { color: '#ffd83a' });
    await wait(700);
    // 2. A passage kept with a note and a tag.
    if (!(await selectWords(ph('b'), mine))) return;
    await press(bar.querySelector('[data-note]'));
    if (mine !== run) return;
    const m = mark(pending, { color: '#8cc8ff' });
    field.textContent = '';
    for (const c of tags.querySelectorAll('.chip')) c.remove();
    tagField.textContent = 'Add a tag';
    tagField.classList.remove('live');
    pop.querySelectorAll('.np-dots i').forEach((i, n) => i.classList.toggle('on', n === 2));
    placePop(m);
    await point(field, 0.2, 0.5);
    await type(field, 'The textbook example. It turns out to be wrong.', mine);
    await point(tagField, 0.3, 0.5);
    tagField.textContent = '';
    tagField.classList.add('live');
    await type(tagField, 'economics', mine);
    if (mine !== run) return;
    await wait(300);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = 'economics ×';
    tags.insertBefore(chip, tagField);
    tagField.textContent = '';
    notes.set(m.dataset.note, { comment: field.textContent, tags: ['economics'] });
    await wait(500);
    await press(document.getElementById('np-done'));
    pop.hidden = true;
    renderList();
    await wait(600);
    // 3. A passage underlined instead.
    if (!(await selectWords(ph('c'), mine))) return;
    await press(bar.querySelector('[data-style="underline"]'));
    if (mine !== run) return;
    mark(pending, { color: '#2f9e44', underline: true });
    pointer.classList.remove('on');
    replay.hidden = false;
  };
  const stopShow = () => { run++; pointer.classList.remove('on'); replay.hidden = false; };

  // ---- your turn: select words in the page
  const check = () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideBar(); return; }
    const range = sel.getRangeAt(0);
    if (!page.contains(range.commonAncestorContainer)) { hideBar(); return; }
    const para = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('p, h3');
    if (!para) { hideBar(); return; }
    if (!para.contains(range.endContainer)) range.setEnd(para, para.childNodes.length);
    if (!range.toString().trim()) { hideBar(); return; }
    placeBar(range);
    pending = range.cloneRange();
  };
  page.addEventListener('pointerdown', (e) => { if (e.isTrusted && pointer.classList.contains('on')) stopShow(); });
  page.addEventListener('mouseup', () => setTimeout(check, 0));
  page.addEventListener('touchend', () => setTimeout(check, 300));
  bar.addEventListener('pointerdown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const b = e.target.closest('button');
    if (!b || !pending) return;
    if (b.dataset.note) { const m = mark(pending, { color: '#8cc8ff' }); notes.set(m.dataset.note, { comment: '' }); renderList(); return; }
    mark(pending, { color: b.dataset.style === 'underline' ? '#2f9e44' : b.dataset.c, underline: b.dataset.style === 'underline' });
  });
  document.getElementById('np-done').addEventListener('click', (e) => { if (e.isTrusted) pop.hidden = true; });
  replay.addEventListener('click', () => { replay.hidden = true; play(); });

  renderList();
  // Played the first time it comes into view; never while it can't be seen.
  let started = false;
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !started) { started = true; setTimeout(play, 400); }
  }, { threshold: 0.5 }).observe(demo);
})();

(() => {
  // ---- The film: Aloud's voices telling a story at sea, at whatever speed you choose.
  const screen = document.getElementById('film-screen');
  if (!screen || !window.ALOUD_FILM) return;
  const LINES = window.ALOUD_FILM;
  const $ = (id) => document.getElementById(id);
  const layers = new Map([...screen.querySelectorAll('.film-layer')].map((l) => [l.dataset.scene, l]));
  const rain = screen.querySelector('.film-rain');
  const flash = screen.querySelector('.film-flash');
  const fog = screen.querySelector('.film-fog');
  const caption = $('film-caption'), badge = $('film-badge'), sound = $('film-sound');
  const fill = $('film-fill'), time = $('film-time'), rateEl = $('film-rate'), playBtn = $('film-play'), track = $('film-track');
  const PLAY = '<path d="M4 2.5v11l9-5.5z"/>';
  const PAUSE = '<path d="M4 2.5h3v11H4z"/><path d="M9 2.5h3v11H9z"/>';
  const STEP = 0.25, MIN = 0.25, MAX = 4;
  // Fetched only as the film comes near, so the rest of the page never waits for it.
  const audio = new Audio();
  audio.preload = 'auto';
  audio.muted = true;
  audio.loop = true;
  let cues = [];
  let length = 0;
  let visible = false;
  let raf = 0;
  let badgeTimer = 0;
  let nextBolt = 0;
  const cast = document.getElementById('film-cast');
  if (cast) cast.textContent = 'Voices: ' + [...new Map(LINES.map((l) => [l.who.name, l.who])).values()].map((w) => `${w.name}, ${w.credit}`).join(' · ');
  const load = () => {
    if (audio.src) return;
    audio.src = 'assets/voices/film.mp3';
    fetch('assets/voices/film.json').then((r) => r.json()).then((j) => { cues = j.cues; length = j.duration; draw(); }).catch(() => {});
  };
  new IntersectionObserver(([e]) => e.isIntersecting && load(), { rootMargin: '600px 0px' }).observe(screen);

  // ---- the sea, made in the browser: noise, swelling like waves, louder in the storm
  let ac = null, sea = null, swell = null;
  const startSea = () => {
    if (ac) return;
    ac = new AudioContext();
    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    sea = ac.createGain();
    sea.gain.value = 0;
    swell = ac.createGain();
    swell.gain.value = 0.5;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.18;
    const depth = ac.createGain();
    depth.gain.value = 0.35;
    lfo.connect(depth).connect(swell.gain);
    src.connect(lp).connect(swell).connect(sea).connect(ac.destination);
    src.start();
    lfo.start();
    sea.lfo = lfo;
  };
  const thunder = () => {
    if (!ac || audio.muted) return;
    const len = ac.sampleRate * 1.6;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.min(2, audio.playbackRate);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const g = ac.createGain();
    g.gain.value = 0.9;
    src.connect(lp).connect(g).connect(ac.destination);
    src.start();
  };

  const sceneAt = (t) => {
    let i = 0;
    cues.forEach((c, n) => { if (t >= c.start - 1) i = n; });
    return { line: cues.findIndex((c) => t >= c.start && t <= c.end + 0.3), scene: LINES[i]?.scene ?? 'calm' };
  };
  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const fmt = (r) => r + '×';
  const draw = () => {
    const t = audio.currentTime;
    const dur = audio.duration || length || 1;
    const { line, scene } = sceneAt(t);
    for (const [name, layer] of layers) {
      const on = name === scene;
      layer.classList.toggle('on', on);
      // A slow camera move that follows the film's own clock, so it speeds up with it.
      if (on) {
        const sway = scene === 'storm' ? Math.sin(t * 2.4) * 1.4 : Math.sin(t * 0.5) * 0.6;
        layer.style.transform = `scale(${1.02 + (t % 30) * 0.003}) translate(${Math.sin(t * 0.13) * 1.5}%, ${sway}%) rotate(${scene === 'storm' ? Math.sin(t * 1.7) * 0.8 : 0}deg)`;
      }
    }
    rain.classList.toggle('on', scene === 'storm');
    rain.style.backgroundPosition = `${-t * 90}px ${t * 520}px`;
    fog.classList.toggle('on', scene === 'fog');
    fog.style.transform = `translateX(${Math.sin(t * 0.2) * 8}%)`;
    if (scene === 'storm' && !audio.paused && t > nextBolt) {
      nextBolt = t + 2.5 + Math.random() * 2;
      flash.animate([{ opacity: 0.85 }, { opacity: 0 }, { opacity: 0.5 }, { opacity: 0 }], { duration: 650 / Math.max(1, audio.playbackRate) });
      setTimeout(thunder, 250);
    }
    if (scene !== 'storm') nextBolt = 0;
    const l = LINES[line];
    caption.innerHTML = '';
    if (l) { const who = document.createElement('i'); who.textContent = l.who.name; caption.append(who, l.text); }
    fill.style.width = (t / dur) * 100 + '%';
    time.textContent = clock(t) + ' / ' + clock(dur);
    rateEl.textContent = fmt(audio.playbackRate);
    if (sea && ac) {
      const level = audio.paused || audio.muted ? 0 : scene === 'storm' ? 0.55 : scene === 'calm' || scene === 'dawn' ? 0.22 : 0.12;
      sea.gain.setTargetAtTime(level, ac.currentTime, 0.4);
      sea.lfo.frequency.setTargetAtTime((scene === 'storm' ? 0.45 : 0.16) * audio.playbackRate, ac.currentTime, 0.3);
    }
  };
  const frame = () => { draw(); raf = visible ? requestAnimationFrame(frame) : 0; };
  const showBadge = (text) => {
    badge.textContent = text;
    badge.hidden = false;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => (badge.hidden = true), 900);
  };
  const setRate = (r) => { audio.playbackRate = Math.round(Math.min(MAX, Math.max(MIN, r)) * 100) / 100; showBadge(fmt(audio.playbackRate)); draw(); };
  const setPlaying = (on) => {
    if (on) audio.play().catch(() => {}); else audio.pause();
    playBtn.querySelector('svg').innerHTML = on ? PAUSE : PLAY;
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  };
  const act = (key) => {
    if (key === 'd') setRate(audio.playbackRate + STEP);
    else if (key === 's') setRate(audio.playbackRate - STEP);
    else if (key === 'r') setRate(1);
    else if (key === 'z') { audio.currentTime = Math.max(0, audio.currentTime - 5); showBadge('−5 s'); }
    else if (key === 'x') { audio.currentTime = Math.min((audio.duration || length) - 0.5, audio.currentTime + 5); showBadge('+5 s'); }
    else if (key === ' ') setPlaying(audio.paused);
    else return false;
    return true;
  };
  const withSound = () => {
    startSea();
    ac.resume();
    audio.muted = false;
    sound.hidden = true;
    if (audio.paused) setPlaying(true);
  };
  sound.addEventListener('click', (e) => { e.stopPropagation(); withSound(); });
  screen.addEventListener('click', () => { if (audio.muted) withSound(); else setPlaying(audio.paused); screen.focus(); });
  playBtn.addEventListener('click', () => setPlaying(audio.paused));
  track.addEventListener('click', (e) => { const r = track.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * (audio.duration || length); draw(); });
  for (const b of document.querySelectorAll('#film .vkeys button')) b.addEventListener('click', () => act(b.dataset.key));
  // The keys work while the film is on screen, as Aloud's do while a video is playing.
  document.addEventListener('keydown', (e) => {
    if (!visible || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (act(e.key.toLowerCase())) e.preventDefault();
  });
  // Plays (silently, until you ask for sound) only while it can be seen.
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) { load(); if (!raf) raf = requestAnimationFrame(frame); setPlaying(true); } else { setPlaying(false); }
  }, { threshold: 0.4 }).observe(screen);
  draw();
})();
