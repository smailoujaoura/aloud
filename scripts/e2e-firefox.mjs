// End-to-end check of the Firefox build in a real (headless) Firefox.
//
//   npm run build:firefox && npm run test:e2e:firefox
//
// What it proves, in order: the add-on installs; the reader starts on an article; the Piper voice
// loads and returns real audio; playback starts; the word highlight steps through the spoken
// words in order; "Save as MP3" produces a downloadable MP3; a highlight made on the page is kept in
// Notes and drawn again after a reload. Exits non-zero on the first failure,
// with a screenshot in .output/e2e-firefox/.
//
// How, since Playwright cannot load extensions into Firefox itself:
//  - Firefox starts with its remote debugging server, and the unpacked build is installed as a
//    temporary add-on over that protocol (what `web-ext run` does).
//  - Host permission — normally granted by the user's click on the toolbar button — is granted
//    from the parent process, then the reader is injected exactly as the button does it.
//  - Playwright drives the web page and the reading bar (by position: its shadow root is closed).
//
// Needs Playwright's Firefox (`npx playwright install firefox`) and an audio output: Firefox never
// starts an AudioContext without one. On a headless Linux box run a PulseAudio null sink and set
// PULSE_SERVER. Extra library folders (GTK, libpulse) can be supplied with E2E_LD_LIBRARY_PATH.
// The first run downloads the default Piper voice (~60 MB).

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADDON_DIR = join(ROOT, '.output/firefox-mv3');
const OUT = join(ROOT, '.output/e2e-firefox');
const ADDON_ID = JSON.parse(readFileSync(join(ADDON_DIR, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
const RDP_PORT = 6000 + Math.floor(Math.random() * 1000);
const VIEWPORT = { width: 1100, height: 800 };

const ARTICLE = `<!doctype html><html lang="en"><title>Aloud Firefox check</title><article>
<h1>Aloud Firefox check</h1>
<p>The quick brown fox jumps over the lazy dog. It was a bright cold day in April.</p>
<p>Reading aloud should mark every word as it is spoken. The file should save as well.</p>
</article></html>`;

const step = (msg) => console.log(`• ${msg}`);
let page = null;

async function fail(msg) {
  console.error(`✗ ${msg}`);
  if (page) await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  process.exit(1);
}

// ---- Firefox remote debugging protocol: length-prefixed JSON ------------------------------------

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

/** Run async `body` in a console actor and return its JSON-able result. */
async function evaluate(rdp, actor, body) {
  const once = async (text) => {
    rdp.send({ to: actor, type: 'evaluateJSAsync', text });
    const first = await rdp.next((m) => m.from === actor && m.resultID);
    const done =
      first.type === 'evaluationResult'
        ? first
        : await rdp.next((m) => m.type === 'evaluationResult' && m.resultID === first.resultID);
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

  // The background page's console, for starting the reader.
  rdp.send({ to: 'root', type: 'listAddons' });
  const { addons } = await rdp.next((m) => m.from === 'root' && m.addons);
  const addon = addons.find((a) => a.id === ADDON_ID);
  rdp.send({ to: addon.actor, type: 'getWatcher' });
  const watcher = await rdp.next((m) => m.from === addon.actor && m.actor);
  rdp.send({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
  const background = await rdp.next((m) => m.type === 'target-available-form' && /background/.test(m.target?.url ?? ''));

  // The parent process's console, for granting what a user's click would.
  rdp.send({ to: 'root', type: 'getProcess', id: 0 });
  const { processDescriptor } = await rdp.next((m) => m.from === 'root' && m.processDescriptor);
  rdp.send({ to: processDescriptor.actor, type: 'getTarget' });
  const parent = await rdp.next((m) => m.from === processDescriptor.actor && (m.process || m.form));

  return { background: background.target.consoleActor, parent: (parent.process ?? parent.form).consoleActor };
}

// ---- the run -------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(ARTICLE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const articleUrl = `http://127.0.0.1:${server.address().port}/article.html`;

const extraLibs = process.env.E2E_LD_LIBRARY_PATH;
const context = await firefox.launchPersistentContext(mkdtempSync(join(tmpdir(), 'aloud-e2e-')), {
  headless: process.env.HEADED ? false : true,
  viewport: VIEWPORT,
  acceptDownloads: true,
  env: {
    ...process.env,
    ...(extraLibs ? { LD_LIBRARY_PATH: [extraLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : {}),
  },
  args: ['-start-debugger-server', String(RDP_PORT)],
  firefoxUserPrefs: {
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'devtools.chrome.enabled': true,
    'xpinstall.signatures.required': false,
    'media.autoplay.default': 0,
    'media.autoplay.blocking_policy': 0,
    'media.autoplay.block-webaudio': false,
  },
});

let rdp = null;
try {
  for (let i = 0; i < 50 && !rdp; i++) {
    rdp = await connectRdp(RDP_PORT).catch(() => null);
    if (!rdp) await new Promise((r) => setTimeout(r, 200));
  }
  if (!rdp) await fail('could not reach Firefox’s debugging server');
  const consoles = await installAddon(rdp);

  /**
   * Click one of the reading bar's buttons, where it really is. The bar lives in a closed shadow
   * root, so its buttons are measured from the content script's own world (where the session is
   * `window.__aloudSession`) and clicked with the real mouse. Fixed coordinates broke the moment
   * the bar gained a button, and then clicked the wrong one.
   */
  const clickBar = async (button) => {
    const at = await evaluate(
      rdp,
      consoles.background,
      `const tab = (await browser.tabs.query({})).find((t) => t.url === ${JSON.stringify(articleUrl)});
       const [result] = await browser.scripting.executeScript({
         target: { tabId: tab.id },
         args: [${JSON.stringify(button)}],
         func: (name) => {
           const el = window.__aloudSession?.bar?.[name];
           if (!el) return null;
           const r = el.getBoundingClientRect();
           return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
         },
       });
       return result?.result ?? null;`,
    );
    if (!at) await fail(`the reading bar has no ${button}`);
    await page.mouse.click(at.x, at.y);
  };
  step(`installed ${ADDON_ID}`);

  await evaluate(
    rdp,
    consoles.parent,
    `const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
     const policy = WebExtensionPolicy.getByID(${JSON.stringify(ADDON_ID)});
     await ExtensionPermissions.add(${JSON.stringify(ADDON_ID)}, { permissions: [], origins: ['*://*/*'] }, policy.extension);`,
  );

  page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  const waitFor = async (re, ms, what, diagnose) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = logs.find((l) => re.test(l));
      if (hit) return hit;
      await page.waitForTimeout(250);
    }
    const more = diagnose ? `\n  state: ${await diagnose().catch((e) => `could not inspect: ${e}`)}` : '';
    await fail(`${what} (waited ${Math.round(ms / 1000)} s)\n  last logs:\n  ${logs.slice(-8).join('\n  ')}${more}`);
  };

  // What a stuck voice load is waiting on, seen from the extension's own origin: the locks it
  // holds or waits for (one per model download), and which model files reached the cache.
  const inspectLoad = async () =>
    JSON.stringify(
      await evaluate(
        rdp,
        consoles.background,
        `const locks = await navigator.locks.query();
         const db = await new Promise((ok, no) => { const r = indexedDB.open('aloud-models'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
         const names = [...db.objectStoreNames];
         const keys = names.length
           ? await new Promise((ok) => { const r = db.transaction(names[0], 'readonly').objectStore(names[0]).getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => ok(['(unreadable)']); })
           : [];
         db.close();
         return { held: locks.held.map((l) => l.name), pending: locks.pending.map((l) => l.name), cached: keys.map((k) => String(k).split('/').pop()) };`,
      ),
    );

  await page.goto(articleUrl);
  await evaluate(
    rdp,
    consoles.background,
    `const tab = (await browser.tabs.query({})).find((t) => t.url === ${JSON.stringify(articleUrl)});
     await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/reader-inject.js'] });
     await new Promise((r) => setTimeout(r, 300));
     await browser.tabs.sendMessage(tab.id, { type: 'activate', mode: 'article' });`,
  );

  step((await waitFor(/planned \d+ sentences/, 30_000, 'the reader did not plan the article')).replace(/^\[aloud\]\s*/, ''));
  // Every run starts from a fresh profile, so the voice (~60 MB) is downloaded from Hugging Face
  // each time. Over a slow line that alone took over four minutes, and the old five-minute limit
  // failed runs whose only fault was the network. E2E_VOICE_TIMEOUT (seconds) overrides it.
  const voiceTimeout = Number(process.env.E2E_VOICE_TIMEOUT) * 1000 || 900_000;
  await waitFor(
    /engine ready/,
    voiceTimeout,
    'the voice did not load — a cold run downloads ~60 MB from Hugging Face; check the line before the app',
    inspectLoad,
  );
  step('voice loaded');
  const chunk = await waitFor(/→ chunk \d+ in [\d.]+s → [\d.]+s audio/, 120_000, 'no audio came back from the engine');
  step(`audio: ${chunk.replace(/^\[aloud\]\s*/, '')}`);

  await clickBar('playBtn');
  await waitFor(/audio output:/, 30_000, 'playback did not start (is there an audio output? see PULSE_SERVER)');
  step('playing');

  const marked = await page.evaluate(async () => {
    const words = [];
    const start = performance.now();
    while (performance.now() - start < 25_000 && words.length < 8) {
      const highlight = CSS.highlights.get('aloud-word');
      const word = highlight && highlight.size ? [...highlight][0].toString() : '';
      if (word && word !== words[words.length - 1]) words.push(word);
      await new Promise((r) => setTimeout(r, 15));
    }
    return words;
  });
  const spoken = 'Aloud Firefox check The quick brown fox jumps over the lazy dog'.split(' ');
  // Every word, in order, none skipped: a short word missed means the mark lags the speech.
  const start = spoken.indexOf(marked[0]);
  const inOrder = start >= 0 && marked.every((w, i) => spoken[start + i] === w);
  if (marked.length < 6 || !inOrder) await fail(`word highlight did not follow the speech word by word: ${JSON.stringify(marked)}`);
  step(`word highlight: ${marked.join(' → ')}`);

  await clickBar('saveBtn');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter'); // "Make the MP3"
  step((await waitFor(/mp3 export: \d+ sentences →|mp3 export failed/, 600_000, 'the MP3 export did not finish')).replace(/^\[aloud\]\s*/, ''));
  if (logs.some((l) => /mp3 export failed/.test(l))) await fail('the MP3 export failed');
  const download = page.waitForEvent('download', { timeout: 15_000 });
  await page.keyboard.press('Enter'); // "Save file"
  const file = await download.catch(() => null);
  if (!file) await fail('“Save file” did not download anything');
  const path = join(OUT, file.suggestedFilename());
  await file.saveAs(path);
  const bytes = readFileSync(path);
  if (bytes.length < 10_000 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) {
    await fail(`the download is not an MP3 (${bytes.length} bytes)`);
  }
  step(`saved ${file.suggestedFilename()} (${Math.round(bytes.length / 1024)} kB)`);

  // Highlights: keep a passage the way Alt+Shift+S does, then reload and expect it drawn again.
  const inTab = (body) =>
    evaluate(rdp, consoles.background, `const tab = (await browser.tabs.query({})).find((t) => t.url === ${JSON.stringify(articleUrl)}); ${body}`);
  const injectAnnotator = () => inTab(`await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/annotate-inject.js'] });`);
  const passage = 'a bright cold day in April';
  const noteHighlights = () =>
    page.evaluate(() => [...CSS.highlights.entries()].filter(([k]) => k.startsWith('aloud-note')).flatMap(([, h]) => [...h].map((r) => r.toString())));
  await injectAnnotator();
  await page.waitForTimeout(400);
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(text);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
  }, passage);
  const saved = await inTab(`return await browser.tabs.sendMessage(tab.id, { type: 'annotate-save-selection' });`);
  if (!saved?.saved) await fail(`the highlight was not saved: ${JSON.stringify(saved)}`);
  if (!(await noteHighlights()).includes(passage)) await fail('the new highlight was not drawn');
  await page.reload();
  await injectAnnotator();
  await page.waitForTimeout(800);
  const restored = await noteHighlights();
  if (!restored.includes(passage)) await fail(`the highlight was not drawn again after a reload: ${JSON.stringify(restored)}`);
  step(`highlight kept and redrawn after reload: “${passage}”`);

  writeFileSync(join(OUT, 'console.log'), logs.join('\n'));
  console.log('✓ Firefox end-to-end check passed');
} finally {
  rdp?.close();
  await context.close().catch(() => {});
  server.close();
}
process.exit(0);
