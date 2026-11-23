// Release checks of the Chromium build in a real (headless) Chromium.
//
//   npm run build:chrome && npm run test:e2e:chromium
//
// What it proves, in order:
//   1. Settings: every view opens, and a settings change from elsewhere redraws, with no error.
//   2. The PDF reader: a PDF is drawn (canvas ink, a text layer), and pdf.js's worker starts from
//      pdfjs-support/worker.mjs (the modern build after its polyfills).
//   3. Dropbox sync, against a fake Dropbox served by Playwright:
//      - Connecting puts this device's note in the file, and a note kept afterwards goes up by itself.
//      - Sync now brings another device's note, place and Continue entry.
//      - Settings travel both ways, and this device keeps its own sites.
//      - A revoked connection is said plainly, and Disconnect drops the token and the alarm.
//   4. A paused reader follows a newer place saved elsewhere, audio queue and all. The user's own
//      later move stands against an older place that arrives late, and is saved on close. A newer
//      place the page cannot follow is not overwritten on close.
// Exits non-zero on the first failure.
//
// No network: voice downloads are refused (nothing here needs speech), and the pages are served
// from tests/fixtures by a server of its own, with open CORS
// headers so the PDF reader fetches without a site permission. The article page needs the
// extension's access to 127.0.0.1, given as a user's click would: written into a fresh profile's
// Preferences between a first and a second launch.
//
// Linux without system libraries: E2E_LD_LIBRARY_PATH adds folders to LD_LIBRARY_PATH.

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'; // route the background's fetches
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let EXT = join(ROOT, '.output/chrome-mv3');
const FIXTURES = join(ROOT, 'tests/fixtures');
if (!existsSync(join(EXT, 'manifest.json'))) throw new Error('No Chromium build: npm run build:chrome first.');
if (process.env.E2E_LD_LIBRARY_PATH) process.env.LD_LIBRARY_PATH = [process.env.E2E_LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

// ---- the pages ---------------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf' };
const server = createServer((req, res) => {
  const path = join(FIXTURES, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(FIXTURES) || !existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  res.end(readFileSync(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---- a profile in which the extension may run on 127.0.0.1 -------------------------------------
let PROFILE = mkdtempSync(join(tmpdir(), 'aloud-e2e-chromium-'));
const launch = () =>
  chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 850 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
let ctx = await launch();
let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
let ID = new URL(sw.url()).host;
await ctx.close();
{
  const file = join(PROFILE, 'Default/Preferences');
  const prefs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const ext = prefs.extensions?.settings?.[ID];
  if (ext) {
    // Linux: the permission a click on the toolbar button would give, written into the profile.
    for (const key of ['active_permissions', 'granted_permissions', 'runtime_granted_permissions']) {
      const perms = (ext[key] ??= {});
      for (const kind of ['explicit_host', 'scriptable_host']) perms[kind] = [...new Set([...(perms[kind] ?? []), 'http://127.0.0.1/*'])];
    }
    writeFileSync(file, JSON.stringify(prefs));
  } else {
    // A Mac, and Windows: Chromium keeps an extension's permissions in Secure Preferences there,
    // signed, and takes an edited one for tampering and forgets it. So the build is copied, and
    // the copy's manifest asks for the test server's address itself. Everything else is the build.
    const copy = mkdtempSync(join(tmpdir(), 'aloud-e2e-build-'));
    cpSync(EXT, copy, { recursive: true });
    const manifestFile = join(copy, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    EXT = copy;
    PROFILE = mkdtempSync(join(tmpdir(), 'aloud-e2e-chromium-'));
    console.log('(permissions from a copy of the build: this system keeps them where they cannot be written)');
  }
}
ctx = await launch();
// Offline: no voice is downloaded (nothing here needs speech), and a request that tried would show.
const blocked = [];
await ctx.route(/huggingface\.co|hf\.co/, (route) => {
  blocked.push(new URL(route.request().url()).host);
  return route.abort();
});
sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
ID = new URL(sw.url()).host;
const inSw = (fn, arg) => sw.evaluate(fn, arg);
await inSw(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, tipsSeen: true, pdfView: 'pages', engine: 'phonon', server: { url: '', model: '', voices: [] } } });
});

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    // The voice download this check refuses (see `blocked`) is reported, as it should be: not a fault.
    if (m.type() === 'error' && !/downloading the \w+ model/.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  return errors;
}

try {
  // ---- 1. Settings -----------------------------------------------------------------------------
  {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    for (const view of ['continue', 'notes', 'voice', 'reading', 'highlights', 'speed', 'pronunciation', 'shortcuts', 'backup', 'advanced']) {
      await page.goto(`chrome-extension://${ID}/options.html#${view}`);
      await page.waitForTimeout(600);
    }
    await inSw(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, speed: 1.15 } });
    });
    await page.waitForTimeout(1200);
    check(errors.length === 0, 'Settings: every view opens and redraws without an error', errors.join(' | '));
    await page.close();
  }

  // ---- 2. The PDF reader -----------------------------------------------------------------------
  {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    const workers = [];
    page.on('worker', (w) => workers.push(new URL(w.url()).pathname));
    await page.goto(`chrome-extension://${ID}/pdf.html?src=${encodeURIComponent(`${ORIGIN}/pdf/en-title-cols.pdf`)}`);
    await page.waitForSelector('#aloud-control-host', { timeout: 30000, state: 'attached' });
    await page.waitForTimeout(2500);
    const spans = await page.evaluate(() => document.querySelectorAll('.text-layer span').length);
    const ink = await page.evaluate(() => {
      const c = document.querySelector('.pdf-page canvas');
      if (!c) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 200) n++;
      return n;
    });
    check(spans > 5 && ink > 20, 'PDF reader: page drawn with its text layer', `${spans} spans, ${ink} dark samples`);
    check(workers.includes('/pdfjs-support/worker.mjs'), 'PDF reader: pdf.js worker starts after its polyfills', workers.join(' '));
    check(errors.length === 0, 'PDF reader: no error', errors.join(' | '));
    await page.close();
  }

  // ---- 3. Dropbox sync, against a fake Dropbox --------------------------------------------------
  {
    const file = { text: null, rev: 0 };
    const log = [];
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Dropbox-API-Result' };
    await ctx.route(/https:\/\/(api|content)\.dropboxapi\.com\/.*/, (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      log.push(path);
      const json = (status, body, headers = {}) => route.fulfill({ status, headers: { ...cors, ...headers }, contentType: 'application/json', body: JSON.stringify(body) });
      if (req.headers()['authorization'] !== 'Bearer good') return json(401, { error_summary: 'invalid_access_token/' });
      const rev = `r${file.rev}`;
      if (path === '/2/files/get_metadata') return file.text === null ? json(409, { error_summary: 'path/not_found/' }) : json(200, { rev });
      if (path === '/2/files/download') return route.fulfill({ status: 200, headers: { ...cors, 'Dropbox-API-Result': JSON.stringify({ rev }) }, body: file.text });
      if (path === '/2/files/upload') {
        const arg = JSON.parse(req.headers()['dropbox-api-arg']);
        const want = arg.mode === 'add' ? null : arg.mode.update;
        if (want !== (file.text === null ? null : rev)) return json(409, { error_summary: 'path/conflict/file/' });
        file.text = req.postData();
        file.rev++;
        return json(200, { rev: `r${file.rev}` });
      }
      return json(404, {});
    });
    const doc = () => (file.text ? JSON.parse(file.text) : null);
    const note = (id, text, t) => ({ id, text, comment: '', source: { key: 'https://example.org/a', title: 'A page', site: 'example.org', reopen: { kind: 'web', url: 'https://example.org/a' } }, at: null, tags: [], createdAt: t, updatedAt: t });
    const local = (key) => inSw(async (k) => (await chrome.storage.local.get(k))[k], key);

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${ID}/options.html#backup`);
    await page.waitForTimeout(1200);
    check(await page.isVisible('#dropboxSync button.primary'), 'Dropbox: Connect shown when not connected');

    await inSw(async (n) => chrome.storage.local.set({ notes: [n] }), note('n1', 'Kept on this computer', 1000));
    await inSw(() => chrome.storage.local.set({ dropboxAuth: { access: 'good', refresh: 'r', expiresAt: Date.now() + 3600e3, accountId: 'dbid:x', who: 'Test Person' } }));
    await page.waitForTimeout(3000);
    check(JSON.stringify(doc()?.notes?.map((n) => n.text)) === '["Kept on this computer"]', 'Dropbox: connecting puts this device’s note in the file');
    check((await inSw(async () => (await chrome.alarms.get('aloud-cloud-sync'))?.periodInMinutes)) === 15, 'Dropbox: a quarter-hourly check while connected');

    await inSw(async (n) => {
      const { notes } = await chrome.storage.local.get('notes');
      await chrome.storage.local.set({ notes: [n, ...notes] });
    }, note('n2', 'Second note here', 2000));
    await page.waitForTimeout(6000);
    check(doc()?.notes?.length === 2, 'Dropbox: a note kept here goes up by itself');

    const other = doc();
    other.notes.unshift(note('n3', 'From the phone', 3000));
    other.positions = { 'https://example.org/long-read': { index: 30, total: 40, excerpt: 'sentence 30', savedAt: Date.now() } };
    other.history = { 'https://example.org/long-read': { source: { key: 'https://example.org/long-read', title: 'A long read from the phone', site: 'example.org', reopen: { kind: 'web', url: 'https://example.org/long-read' } }, index: 30, total: 40, charsRead: 3000, charsTotal: 4000, listenedSeconds: 180, secondsPerChar: 0.06, finished: false, firstReadAt: Date.now() - 600000, lastReadAt: Date.now() } };
    other.settings.speed = { v: 1.9, at: Date.now() };
    other.settings.mediaSpeed.v = { ...other.settings.mediaSpeed.v, neverOn: ['github.com'] };
    file.text = JSON.stringify(other);
    file.rev++;
    await inSw(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, mediaSpeed: { ...settings.mediaSpeed, alwaysOn: ['example.org'] } } });
    });
    await page.waitForTimeout(5000);
    await page.click('text=Sync now');
    await page.waitForTimeout(2500);
    const notes = (await local('notes')).map((n) => n.text);
    check(notes.includes('From the phone'), 'Dropbox: Sync now brings another device’s note');
    check((await local('readingPositions'))?.['https://example.org/long-read']?.index === 30, 'Dropbox: and its place');
    check(!!(await local('readingHistory'))?.['https://example.org/long-read'], 'Dropbox: and its Continue entry');
    const settings = await local('settings');
    check(settings.speed === 1.9 && settings.mediaSpeed.neverOn.includes('github.com'), 'Dropbox: another device’s settings arrive');
    check(JSON.stringify(settings.mediaSpeed.alwaysOn) === '["example.org"]', 'Dropbox: this device keeps its own sites');
    check(!('engine' in (doc().settings ?? {})) && !('alwaysOn' in (doc().settings.mediaSpeed?.v ?? {})), 'Dropbox: voices and sites never go into the file');

    await inSw(async () => {
      const { dropboxAuth } = await chrome.storage.local.get('dropboxAuth');
      await chrome.storage.local.set({ dropboxAuth: { ...dropboxAuth, access: 'bad', refresh: 'bad' } });
    });
    await page.click('text=Sync now');
    await page.waitForTimeout(2500);
    check(/access was taken back/.test(await page.textContent('#dropboxSync [role=status]')), 'Dropbox: a revoked connection is said plainly');
    await page.click('text=Disconnect');
    await page.waitForTimeout(1500);
    check(!(await local('dropboxAuth')) && !(await inSw(() => chrome.alarms.get('aloud-cloud-sync'))), 'Dropbox: Disconnect drops the token and the alarm');
    check((await local('notes')).length === 3, 'Dropbox: notes stay after Disconnect');
    await ctx.unroute(/https:\/\/(api|content)\.dropboxapi\.com\/.*/);
    await page.close();
  }

  // ---- 4. A paused reader and a newer place saved elsewhere --------------------------------------
  {
    await inSw(() => chrome.storage.local.set({ readingPositions: {} }));
    const page = await ctx.newPage();
    const url = `${ORIGIN}/long-article.html`;
    await page.goto(url);
    await page.waitForTimeout(800);
    const tab = await inSw(async (u) => (await chrome.tabs.query({ url: u })).at(-1)?.id, url);
    const inPage = (fn, arg) =>
      inSw(async ([t, src, a]) => (await chrome.scripting.executeScript({ target: { tabId: t }, func: new Function('a', `return (${src})(a)`), args: [a ?? null] }))[0]?.result, [tab, fn.toString(), arg ?? null]);
    const open = async () => {
      await inSw(async (t) => {
        await chrome.scripting.executeScript({ target: { tabId: t }, files: ['/reader-inject.js'] });
        await chrome.tabs.sendMessage(t, { type: 'activate', mode: 'article' }, { frameId: 0 });
      }, tab);
      await page.waitForTimeout(2500);
    };
    const close = async () => {
      await inPage(() => window.__aloudSession?.stop('user'));
      await page.waitForTimeout(800);
    };
    const seek = (i) => inPage((n) => window.__aloudSession.seekTo(n, { quiet: true }), i);
    const at = () => inPage(() => window.__aloudSession?.state.currentIndex);
    const stored = async () => Object.values((await inSw(async () => (await chrome.storage.local.get('readingPositions')).readingPositions)) ?? {})[0];
    const store = (pos) =>
      inSw(async (p) => {
        const all = (await chrome.storage.local.get('readingPositions')).readingPositions ?? {};
        await chrome.storage.local.set({ readingPositions: { ...all, [Object.keys(all)[0]]: p } });
      }, pos);

    await open();
    await seek(30);
    await close();
    const p30 = await stored();
    await open();
    await seek(20);
    await close();
    check(p30?.index === 30 && (await stored())?.index === 20, 'Reader: closing saves the place');

    await open();
    check((await at()) === 20, 'Reader: reopening picks up at the place');
    await store({ ...p30, savedAt: Date.now() + 1000 });
    await page.waitForTimeout(700);
    const queue = await inPage(() => window.__aloudSession.scheduler.nextToSchedule);
    check((await at()) === 30 && queue === 30, 'Reader: paused, it follows a newer place, audio queue and all', `at ${await at()}, queue ${queue}`);
    await seek(33);
    await store({ ...p30, index: 20, savedAt: Date.now() - 60_000 });
    await page.waitForTimeout(700);
    check((await at()) === 33, 'Reader: an older place arriving late does not undo the user’s move');
    await close();
    check((await stored())?.index === 33, 'Reader: the user’s own move is saved on close');

    await open();
    const foreign = { index: 25, total: 60, excerpt: 'a sentence this page does not have at all', savedAt: Date.now() + 5000 };
    await store(foreign);
    await page.waitForTimeout(700);
    await seek(7);
    await close();
    check((await stored())?.excerpt === foreign.excerpt, 'Reader: a newer place it cannot follow is not overwritten on close');
    await page.close();
  }
} finally {
  await ctx.close();
  server.close();
}

if (blocked.length) console.log(`(voice downloads blocked, as intended: ${blocked.length} request(s) to ${[...new Set(blocked)].join(', ')})`);
console.log(failures === 0 ? '\nAll Chromium checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
