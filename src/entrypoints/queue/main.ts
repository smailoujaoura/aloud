/**
 * The reading queue page: plays saved articles one after another.
 *
 * Articles are played *here*, not by opening each one in a tab. After a navigation a browser will
 * not start audio until that new page has been clicked, so a queue that opened tabs would stop at
 * "Press ▶" on every article. On one page, a single Play click carries the whole queue.
 *
 * An article added from its page is already extracted (see `shared/reading-queue.ts`) and plays
 * offline. A link added from a context menu is downloaded when its turn comes, after asking for
 * permission for that one site if Aloud does not have it yet.
 */
import { browser } from 'wxt/browser';
import { ReaderSession } from '@/content/session';
import { elementToText, extractArticle } from '@/extract/readability';
import { el } from '@/shared/dom';
import { documentKey } from '@/shared/position-match';
import {
  clearQueue,
  loadQueue,
  moveInQueue,
  removeFromQueue,
  updateQueueItem,
  watchQueue,
  type QueueItem,
  type QueuedArticle,
} from '@/shared/reading-queue';
import { getSettings, watchSettings } from '@/shared/settings';
import { applyTheme, watchSystemTheme } from '@/ui/theme';
import { log } from '@/shared/log';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let queue: QueueItem[] = [];
let playingId: string | null = null;
let session: ReaderSession | null = null;

// ---- list ------------------------------------------------------------------

function renderList(): void {
  const n = queue.length;
  $('count').textContent = n === 0 ? 'Empty' : `${n} article${n === 1 ? '' : 's'} · plays top to bottom`;
  $('empty').hidden = n > 0 || playingId !== null;
  $('playAll').hidden = n === 0 || playingId !== null;
  $('clear').hidden = n === 0;

  $('list').replaceChildren(
    ...queue.map((item, i) => {
      const playing = item.id === playingId;
      const row = el(document, 'li', { class: `q-item${playing ? ' is-playing' : ''}` });

      const text = el(document, 'div', { class: 'q-text' });
      const title = el(document, 'a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', class: 'q-title' }, item.title);
      const meta = [item.site, item.article ? 'saved for offline' : 'downloads when played'];
      text.append(title, el(document, 'span', { class: 'q-meta' }, meta.join(' · ')));

      const actions = el(document, 'div', { class: 'q-actions' });
      if (playing) {
        actions.append(el(document, 'span', { class: 'pill in-use' }, 'Reading now'));
      } else {
        const read = el(document, 'button', { type: 'button', class: 'btn-sm' }, '▶ Read');
        read.addEventListener('click', () => void play(item.id));
        actions.append(read);
      }
      const up = iconButton('↑', 'Move up', i === 0, () => void moveInQueue(item.id, -1));
      const down = iconButton('↓', 'Move down', i === n - 1, () => void moveInQueue(item.id, 1));
      const remove = iconButton('✕', 'Remove from queue', false, () => void removeItem(item.id));
      actions.append(up, down, remove);

      row.append(el(document, 'span', { class: 'q-num' }, String(i + 1)), text, actions);
      return row;
    }),
  );
}

function iconButton(label: string, title: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = el(document, 'button', { type: 'button', class: 'ghost btn-sm q-icon', title, 'aria-label': title }, label);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

async function removeItem(id: string): Promise<void> {
  if (id === playingId) await stopPlaying();
  queue = await removeFromQueue(id);
  renderList();
}

// ---- playing ---------------------------------------------------------------

async function play(id: string): Promise<void> {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  await stopPlaying();
  playingId = id;
  renderList();
  $('now').hidden = false;
  $('nowLabel').textContent = `Now reading · ${item.site}`;
  $('article').replaceChildren();

  const article = item.article ?? (await downloadArticle(item));
  if (playingId !== id) return; // superseded while downloading
  if (!article) {
    await next(id); // skipped
    return;
  }

  renderArticle(item, article);
  window.scrollTo({ top: $('now').offsetTop - 16, behavior: 'smooth' });

  const root = $('article');
  session = new ReaderSession();
  await session
    .begin('article', {
      knownArticle: {
        root,
        text: elementToText(root),
        title: item.title,
        lang: article.lang,
        key: documentKey(item.url),
      },
      autoplay: true,
      showTips: false,
      onFinished: () => void next(id),
    })
    .catch((err) => log.error('[queue] reader failed to start:', err));
}

/** `finishedId` has been read: it leaves the queue, and the one after it starts. */
async function next(finishedId: string): Promise<void> {
  const index = queue.findIndex((q) => q.id === finishedId);
  const following = index >= 0 ? queue[index + 1] : undefined;
  queue = await removeFromQueue(finishedId);
  if (following) {
    toast(`Next: ${following.title}`);
    await play(following.id);
  } else {
    await stopPlaying();
    renderList();
    toast('That was the last article in your queue');
  }
}

async function stopPlaying(): Promise<void> {
  const current = session;
  session = null;
  playingId = null;
  await current?.dispose();
  $('prompt').hidden = true;
}

// ---- articles --------------------------------------------------------------

/** Render a saved article as a clean, safe document the reader session can run on. */
function renderArticle(item: QueueItem, article: QueuedArticle): void {
  const root = $('article');
  const nodes: Node[] = [el(document, 'h1', {}, item.title)];
  if (article.byline) nodes.push(el(document, 'p', { class: 'byline muted' }, article.byline));
  if (article.html) {
    nodes.push(sanitised(article.html));
  } else {
    for (const paragraph of article.text.split(/\n+/)) {
      if (paragraph.trim()) nodes.push(el(document, 'p', {}, paragraph.trim()));
    }
  }
  root.replaceChildren(...nodes);
}

/**
 * Readability's output, minus anything that could run or submit: no scripts, frames, forms or
 * event handlers, and every link opening in a new tab. Parsed with DOMParser into an inert
 * document and imported node by node — never assigned as markup to the live page.
 */
function sanitised(html: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed
    .querySelectorAll('script, style, link, meta, iframe, frame, object, embed, form, input, button, select, textarea, noscript, template')
    .forEach((n) => n.remove());
  for (const node of parsed.body.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const unsafeUrl = (name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|data):/i.test(attr.value);
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'srcset' || unsafeUrl) {
        node.removeAttribute(attr.name);
      }
    }
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy');
  }
  const fragment = document.createDocumentFragment();
  for (const child of [...parsed.body.childNodes]) fragment.appendChild(document.importNode(child, true));
  return fragment;
}

/**
 * Download and extract a queued link, asking for permission for its site first when needed.
 * Resolves to null when the reader chooses to skip it or the download fails.
 */
async function downloadArticle(item: QueueItem): Promise<QueuedArticle | null> {
  const origin = `${new URL(item.url).origin}/*`;
  const allowed = await browser.permissions.contains({ origins: [origin] }).catch(() => false);
  if (!allowed && !(await askPermission(item, origin))) return null;

  const prompt = $('prompt');
  prompt.hidden = false;
  prompt.replaceChildren(el(document, 'span', { class: 'spinner' }), document.createTextNode(` Downloading the article from ${item.site}…`));
  try {
    const res = await fetch(item.url, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    // Resolve the article's relative links and images against where it actually came from.
    const base = doc.createElement('base');
    base.href = res.url;
    doc.head.prepend(base);
    const extracted = extractArticle(doc);
    if (!extracted.html && extracted.text.length < 200) throw new Error("it doesn't look like an article");
    const article: QueuedArticle = { html: extracted.html, text: extracted.text, lang: extracted.lang, byline: extracted.byline };
    const title = extracted.title || item.title;
    await updateQueueItem(item.id, { article, title });
    item.article = article;
    item.title = title;
    prompt.hidden = true;
    return article;
  } catch (err) {
    log.warn('[queue] download failed:', err);
    toast(`Could not read ${item.site} — ${err instanceof Error ? err.message : String(err)}. Skipping it.`, 'error');
    prompt.hidden = true;
    return null;
  }
}

/** Ask, from a real click, to download from this one site. */
function askPermission(item: QueueItem, origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const prompt = $('prompt');
    prompt.hidden = false;
    const allow = el(document, 'button', { type: 'button', class: 'primary btn-sm' }, `Allow ${item.site} and read`);
    const skip = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Skip this one');
    allow.addEventListener('click', () => {
      // permissions.request must run inside the click itself, before any await.
      void browser.permissions
        .request({ origins: [origin] })
        .catch(() => false)
        .then((granted) => {
          prompt.hidden = true;
          if (!granted) toast(`Not allowed to read ${item.site} — skipping it`, 'error');
          resolve(granted);
        });
    });
    skip.addEventListener('click', () => {
      prompt.hidden = true;
      resolve(false);
    });
    const text = el(document, 'p', {}, `“${item.title}” is a link, so Aloud has to download it from ${item.site} first. That needs your permission for that one site.`);
    const actions = el(document, 'div', { class: 'q-prompt-actions' });
    actions.append(allow, skip);
    prompt.replaceChildren(text, actions);
  });
}

// ---- feedback & wiring -----------------------------------------------------

let toastTimer = 0;
function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const box = $('toast');
  box.className = kind === 'error' ? 'toast error' : 'toast';
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (box.hidden = true), 3500);
}

async function init(): Promise<void> {
  const settings = await getSettings();
  applyTheme(document, settings.theme);
  watchSystemTheme(() => void getSettings().then((s) => applyTheme(document, s.theme)));
  watchSettings((s) => applyTheme(document, s.theme));

  queue = await loadQueue();
  renderList();
  // Articles added from other tabs while this page is open appear straight away.
  watchQueue((next) => {
    queue = next;
    renderList();
  });

  $('playAll').addEventListener('click', () => {
    const first = queue[0];
    if (first) void play(first.id);
  });
  $('clear').addEventListener('click', async () => {
    if (!confirm('Remove every article from your reading queue?')) return;
    await stopPlaying();
    await clearQueue();
    $('now').hidden = true;
    queue = [];
    renderList();
  });
  window.addEventListener('pagehide', () => void session?.dispose());
}

void init();
