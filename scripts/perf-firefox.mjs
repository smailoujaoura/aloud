// How smoothly a page runs while Aloud reads it, measured in the Firefox installed on this machine.
//
//   npm run build:firefox && npm run perf:firefox
//   node scripts/perf-firefox.mjs [repo=.] [paragraphs=400] [page changes a second=2000] [seconds=30]
//
// It opens a long article that also keeps changing itself (a ticker adding, editing and removing
// nodes, as feeds and animations do), and prints the page's own frame times, and what each of its
// changes costs, before the reader opens, while the voice loads, and while it reads. A steady page
// shows 600 frames in 10 s with none over 25 ms, and a change costing a microsecond or two. This is
// what showed a page read by Aloud 1.0.4 running at 8 to 40 frames a second (CHANGELOG, 1.0.5).
//
// Firefox itself, headless, in a throwaway profile, driven over its remote debugging protocol
// (as scripts/e2e-firefox.mjs installs the add-on): Playwright's own Firefox runs WebAssembly many
// times slower, which is no measure of anything. A fresh profile downloads the voice each time.
//
// Env: ENGINE=phonon|piper|kokoro|supertonic · SPEED=1.5 · SETTINGS='{"wordHighlight":"off"}'
//      PROFILE=1 times the reader's own methods, and synthesis against real time
//      SPEED_CONTROL=1 also measures the video speed control · SKIP_READ=1 stops before reading
//      RANGES=500,2500 measures page changes against that many live Ranges (no add-on involved)
//      FIREFOX=/path/to/firefox · HEADED=1 shows the window
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const PARAGRAPHS = Number(process.argv[3] ?? 400);
// Changes by default: a page that never changes cannot show what each change costs, which is what
// 1.0.4's slowdown was.
const MUTATIONS = Number(process.argv[4] ?? 2000);
const SECONDS = Number(process.argv[5] ?? 30);
const ADDON_DIR = join(ROOT, process.env.ADDON_DIR ?? '.output/firefox-mv3');
const ADDON_ID = JSON.parse(readFileSync(join(ADDON_DIR, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
const RDP_PORT = 6000 + Math.floor(Math.random() * 1000);
const FIREFOX =
  process.env.FIREFOX ??
  (process.platform === 'darwin'
    ? '/Applications/Firefox.app/Contents/MacOS/firefox'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
      : 'firefox');

const SENTENCES = [
  'The harbour was quiet that morning, and the gulls kept to the far end of the pier.',
  'Nobody had expected the ferry to arrive before noon, yet there it was, low in the water.',
  'She counted the crates twice, wrote the number down, and counted them again to be sure.',
  'A small boy sold oranges from a basket and gave change from a tin he kept under his coat.',
  'By the time the fog lifted, the town had already decided what it thought of the newcomers.',
  'It was the kind of weather that made old sailors talk about years nobody else remembered.',
];
const page = (paragraphs, mutations) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Aloud perf page</title>
<style>body{font:18px/1.6 Georgia,serif;max-width:720px;margin:40px auto}#spin{width:40px;height:40px;background:#c33;position:fixed;top:10px;right:10px}</style></head>
<body><div id="spin"></div><div id="ticker" aria-hidden="true"></div><article><h1>Aloud perf page</h1>
${Array.from({ length: paragraphs }, (_, p) => `<p>${SENTENCES.map((s, i) => SENTENCES[(i + p) % SENTENCES.length]).join(' ')}</p>`).join('\n')}
</article>
<script>
  // Frame gaps, as the page itself sees them.
  let last = performance.now(); let gaps = [];
  const spin = document.getElementById('spin'); let angle = 0;
  const frame = (t) => { gaps.push(t - last); last = t; angle += 3; spin.style.transform = 'rotate(' + angle + 'deg)'; mutate(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  window.__stats = (reset) => {
    const g = gaps.slice().sort((a, b) => a - b); const n = g.length; const q = (p) => n ? +g[Math.min(n - 1, Math.floor(n * p))].toFixed(1) : 0;
    const out = { frames: n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: n ? +g[n - 1].toFixed(1) : 0, over25: g.filter((x) => x > 25).length, over50: g.filter((x) => x > 50).length, over100: g.filter((x) => x > 100).length, mutationMs: +mutationMs.toFixed(1), mutations: mutationCount };
    if (reset) { gaps = []; mutationMs = 0; mutationCount = 0; }
    return out;
  };
  // A page that keeps changing: a ticker that adds, edits and removes nodes, timed.
  let mutationMs = 0, mutationCount = 0;
  // Driven by the frames themselves: a timer is slowed to once a second in a window not in front.
  const ticker = document.getElementById('ticker'); const perTick = ${mutations} / 240;
  function mutate() {
    if (perTick <= 0) return;
    const t0 = performance.now();
    for (let i = 0; i < perTick; i++) {
      const s = document.createElement('span'); s.textContent = 'x'; ticker.append(s);
      s.className = 'a' + i; s.firstChild.data = 'y'; if (ticker.childNodes.length > 20) ticker.firstChild.remove();
      mutationCount += 4;
    }
    mutationMs += performance.now() - t0;
  }
</script></body></html>`;

function connectRdp(port) {
  return new Promise((resolveConnection, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    const waiting = [];
    const unclaimed = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      for (;;) {
        const colon = buffer.indexOf(58);
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        if (buffer.length < colon + 1 + length) return;
        const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
        buffer = buffer.subarray(colon + 1 + length);
        const i = waiting.findIndex((w) => w.match(packet));
        if (i >= 0) waiting.splice(i, 1)[0].resolve(packet);
        else unclaimed.push(packet);
      }
    });
    socket.on('error', reject);
    socket.on('connect', () =>
      resolveConnection({
        send(packet) {
          const text = JSON.stringify(packet);
          socket.write(`${Buffer.byteLength(text)}:${text}`);
        },
        next(match) {
          const i = unclaimed.findIndex(match);
          if (i >= 0) return Promise.resolve(unclaimed.splice(i, 1)[0]);
          return new Promise((res) => waiting.push({ match, resolve: res }));
        },
        close: () => socket.end(),
      }),
    );
  });
}

async function evaluate(rdp, actor, body) {
  const once = async (text) => {
    rdp.send({ to: actor, type: 'evaluateJSAsync', text });
    const first = await rdp.next((m) => m.from === actor && m.resultID);
    const done = first.type === 'evaluationResult' ? first : await rdp.next((m) => m.type === 'evaluationResult' && m.resultID === first.resultID);
    if (done.exceptionMessage) throw new Error(done.exceptionMessage);
    return done.result;
  };
  const key = `__e2e${Math.random().toString(36).slice(2)}`;
  await once(
    `globalThis.${key} = undefined; (async () => { ${body} })().then(` +
      `(v) => { globalThis.${key} = JSON.stringify({ v }); }, (e) => { globalThis.${key} = JSON.stringify({ e: String(e) }); }); 0`,
  );
  for (;;) {
    const result = await once(`globalThis.${key}`);
    if (typeof result === 'string') {
      const parsed = JSON.parse(result);
      if ('e' in parsed) throw new Error(parsed.e);
      return parsed.v;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function installAddon(rdp) {
  await rdp.next((m) => m.from === 'root');
  rdp.send({ to: 'root', type: 'getRoot' });
  const root = await rdp.next((m) => m.from === 'root' && m.addonsActor);
  rdp.send({ to: root.addonsActor, type: 'installTemporaryAddon', addonPath: ADDON_DIR, openDevTools: false });
  const installed = await rdp.next((m) => m.from === root.addonsActor);
  if (!installed.addon) throw new Error(`install failed: ${JSON.stringify(installed)}`);
  rdp.send({ to: 'root', type: 'listAddons' });
  const { addons } = await rdp.next((m) => m.from === 'root' && m.addons);
  const addon = addons.find((a) => a.id === ADDON_ID);
  rdp.send({ to: addon.actor, type: 'getWatcher' });
  const watcher = await rdp.next((m) => m.from === addon.actor && m.actor);
  rdp.send({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
  const background = await rdp.next((m) => m.type === 'target-available-form' && /background/.test(m.target?.url ?? ''));
  rdp.send({ to: 'root', type: 'getProcess', id: 0 });
  const { processDescriptor } = await rdp.next((m) => m.from === 'root' && m.processDescriptor);
  rdp.send({ to: processDescriptor.actor, type: 'getTarget' });
  const parent = await rdp.next((m) => m.from === processDescriptor.actor && (m.process || m.form));
  return { background: background.target.consoleActor, parent: (parent.process ?? parent.form).consoleActor };
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(PARAGRAPHS, MUTATIONS));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/article.html`;

const profile = mkdtempSync(join(tmpdir(), 'aloud-perf-'));
writeFileSync(
  join(profile, 'user.js'),
  Object.entries({
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'devtools.chrome.enabled': true,
    'xpinstall.signatures.required': false,
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    'media.autoplay.block-webaudio': false,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'browser.aboutwelcome.enabled': false,
    'app.update.enabled': false,
    'media.volume_scale': '0.0',
    'layout.testing.top-level-always-active': true,
    'dom.min_background_timeout_value': 4,
    'dom.timeout.enable_budget_timer_throttling': false,
    'browser.tabs.remote.separatePrivilegedMozillaWebContentProcess': false,
  })
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n'),
);
const ff = spawn(FIREFOX, ['-no-remote', ...(process.env.HEADED ? [] : ['-headless']), '-profile', profile, '-start-debugger-server', String(RDP_PORT), 'about:blank'], { stdio: 'ignore' });
const done = (code) => {
  try { ff.kill('SIGKILL'); } catch {}
  server.close();
  process.exit(code);
};
process.on('SIGINT', () => done(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let rdp = null;
  for (let i = 0; i < 100 && !rdp; i++) {
    rdp = await connectRdp(RDP_PORT).catch(() => null);
    if (!rdp) await sleep(200);
  }
  if (!rdp) throw new Error('could not reach Firefox’s debugging server');
  const consoles = await installAddon(rdp);
  await evaluate(
    rdp,
    consoles.parent,
    `const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
     const policy = WebExtensionPolicy.getByID(${JSON.stringify(ADDON_ID)});
     await ExtensionPermissions.add(${JSON.stringify(ADDON_ID)}, { permissions: [], origins: ['*://*/*'] }, policy.extension);`,
  );
  const bg = (body) => evaluate(rdp, consoles.background, body);
  const patch = { debug: true, tipsSeen: true };
  if (process.env.ENGINE) patch.engine = process.env.ENGINE;
  if (process.env.SPEED) patch.speed = Number(process.env.SPEED);
  if (process.env.SETTINGS) Object.assign(patch, JSON.parse(process.env.SETTINGS));
  await bg(`const { settings = {} } = await browser.storage.local.get('settings');
    await browser.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } });
    await browser.tabs.create({ url: ${JSON.stringify(url)}, active: true });`);
  const inTab = (body) => bg(`const tab = (await browser.tabs.query({})).find((t) => t.url === ${JSON.stringify(url)}); ${body}`);
  const stats = (reset = true) => inTab(`const [r] = await browser.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', args: [${reset}], func: (reset) => window.__stats(reset) }); return r?.result;`);
  const session = (expr) => inTab(`const [r] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const s = window.__aloudSession; if (!s) return null; ${expr} } }); return r?.result ?? null;`);
  const report = (label, s) => console.log(`${label.padEnd(34)} frames=${String(s.frames).padStart(5)} p50=${s.p50} p95=${s.p95} p99=${s.p99} max=${s.max} >25ms=${s.over25} >50ms=${s.over50} >100ms=${s.over100}${s.mutations ? `  mutation cost ${(s.mutationMs / s.mutations * 1000).toFixed(2)} µs each (${s.mutationMs} ms total)` : ''}`);

  await sleep(3000);
  await stats(true);
  await sleep(10_000);
  report('baseline, no reader (10 s)', await stats(true));
  if (process.env.SPEED_CONTROL) {
    await inTab(`await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/speed-inject.js'] });`);
    await sleep(1000);
    await stats(true);
    await sleep(10_000);
    report('video speed control on (10 s)', await stats(true));
  }
  if (process.env.RANGES) {
    for (const n of process.env.RANGES.split(',').map(Number)) {
      await inTab(`await browser.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', args: [${n}], func: (n) => {
        const held = (window.__held ??= []);
        const texts = [...document.querySelectorAll('article p')].map((p) => p.firstChild);
        while (held.length < n) { const t = texts[held.length % texts.length]; const r = document.createRange(); const at = (held.length * 7) % 200; r.setStart(t, at); r.setEnd(t, at + 40); held.push(r); }
      } });`);
      await stats(true);
      await sleep(6000);
      report('page holding ' + n + ' live Ranges (6 s)', await stats(true));
    }
  }
  if (process.env.SKIP_READ) done(0);

  const t0 = Date.now();
  await inTab(`await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/reader-inject.js'] });
     await new Promise((r) => setTimeout(r, 300));
     await browser.tabs.sendMessage(tab.id, { type: 'activate', mode: 'article' });`);
  let planned = null;
  for (let i = 0; i < 120 && !planned; i++) {
    await sleep(250);
    planned = await session(`return s.playlist?.length ? { sentences: s.playlist.length, status: s.state?.status } : null;`);
  }
  if (!planned) throw new Error('the reader did not plan the article');
  console.log(`planned ${planned.sentences} sentences in ${Date.now() - t0} ms`);
  report('while planning + opening', await stats(true));

  if (process.env.PROFILE) {
    await session(`
      const T = (window.__aloudTimes = {});
      const wrap = (obj, label) => {
        if (!obj) return;
        const seen = new Set();
        for (let proto = obj; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor' || seen.has(name)) continue;
            seen.add(name);
            const d = Object.getOwnPropertyDescriptor(proto, name);
            if (!d || typeof d.value !== 'function') continue;
            const fn = d.value; const key = label + '.' + name;
            obj[name] = function (...args) {
              const t0 = performance.now();
              try { return fn.apply(this, args); }
              finally { const dt = performance.now() - t0; const e = (T[key] ??= { n: 0, total: 0, max: 0 }); e.n++; e.total += dt; if (dt > e.max) e.max = dt; }
            };
          }
        }
      };
      const C = (window.__aloudChunks = []);
      const realDeliver = s.worker.deliver;
      s.worker.deliver = function (key, playId, pcm, sr, words) { C.push({ t: performance.now(), id: playId, sec: sr ? pcm.length / sr : 0, words: words ? words.length : 0 }); return realDeliver.apply(this, arguments); };
      wrap(s, 'session'); wrap(s.scheduler, 'scheduler'); wrap(s.highlighter, 'highlighter'); wrap(s.bar, 'bar'); wrap(s.worker, 'worker');
      // Timers and observers of the content script itself, by where they were set.
      const realTimeout = window.setTimeout.bind(window);
      return Object.keys(T).length;`);
  }
  // Wait for the voice (a cold profile downloads it), reporting frames meanwhile.
  let ready = false;
  const loadStart = Date.now();
  while (!ready && Date.now() - loadStart < 900_000) {
    await sleep(2000);
    const st = await session(`return { ready: !!s.engineReady, status: s.state?.status, hint: s.state?.hint ?? '', error: s.state?.error ?? '' };`);
    if (!st) throw new Error('the session went away');
    if (st.error) throw new Error(`voice: ${st.error}`);
    ready = st.ready;
  }
  if (!ready) throw new Error('the voice did not load');
  console.log(`voice ready after ${Math.round((Date.now() - loadStart) / 1000)} s`);
  report('while the voice loaded', await stats(true));

  await sleep(4000);
  report('ready, buffering, not playing (4 s)', await stats(true));
  await session(`s.bar?.playBtn?.click(); return true;`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = await session(`return s.state?.status;`);
    if (st === 'playing') break;
  }
  await stats(true);
  for (let lap = 0; lap < Math.ceil(SECONDS / 10); lap++) {
    await sleep(10_000);
    const st = await session(`const sc = s.scheduler; return { status: s.state?.status, at: s.currentPlayId, backend: s.backend, busy: !!s.state?.busy, hint: s.state?.hint ?? '', ctx: sc.ctx?.state, t: sc.ctx ? +sc.ctx.currentTime.toFixed(1) : null, next: sc.nextToSchedule, sources: sc.sources?.size, ready: sc.ready?.size, running: sc.running, touch: s.tuning ? JSON.stringify(s.tuning) : '' };`);
    report(`reading (${JSON.stringify(st)})`, await stats(true));
  }
  if (process.env.PROFILE) {
    const chunks = await session(`return window.__aloudChunks;`);
    if (chunks?.length > 1) {
      const span = (chunks[chunks.length - 1].t - chunks[0].t) / 1000;
      const audio = chunks.slice(1).reduce((n, c) => n + c.sec, 0);
      console.log(`synthesis: ${chunks.length} sentences, ${audio.toFixed(1)} s of audio in ${span.toFixed(1)} s (${(audio / span).toFixed(2)}x real time), words on ${chunks.filter((c) => c.words).length}`);
    }
    const times = await session(`return window.__aloudTimes;`);
    const rows = Object.entries(times ?? {}).map(([k, v]) => ({ k, ...v })).filter((r) => r.total > 5 || r.max > 5).sort((a, b) => b.total - a.total).slice(0, 40);
    for (const r of rows) console.log(`  ${r.k.padEnd(44)} calls=${String(r.n).padStart(6)} total=${r.total.toFixed(0).padStart(6)} ms  max=${r.max.toFixed(0)} ms`);
  }
  done(0);
} catch (err) {
  console.error('FAILED:', err.message);
  done(1);
}
