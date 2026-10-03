/**
 * "Up next": the reading queue, played article after article on this page.
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
import { formatListeningTime } from '@/shared/reading-history';
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
import { getSettings } from '@/shared/settings';
import { log } from '@/shared/log';
import { $, toast } from './feedback';
import { heldCount, releaseHeld, sanitised } from './article-sanitise';

let queue: QueueItem[] = [];
/** Articles this sitting could not download: kept in the queue, not started again by "next". */
const failed = new Set<string>();
let playingId: string | null = null;
let session: ReaderSession | null = null;
let speed = 1;
let onCountChange: (count: number) => void = () => {};

/** Speech runs at about this many characters a second at 1×; enough for "about 6 min". */
const CHARS_PER_SECOND = 14;

function listeningSeconds(item: QueueItem): number | null {
  return item.article ? item.article.text.length / CHARS_PER_SECOND / speed : null;
}



// ---- list ------------------------------------------------------------------

function renderList(): void {
  const n = queue.length;
  const known = queue.map(listeningSeconds);
  const total = known.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  const unknown = known.filter((s) => s == null).length;
  onCountChange(n);
  $('count').textContent =
    n === 0
      ? 'Empty'
      : `${n} article${n === 1 ? '' : 's'} · about ${formatListeningTime(total)}${unknown ? ` plus ${unknown} not yet downloaded` : ''} · plays top to bottom`;
  $('empty').hidden = n > 0 || playingId !== null;
  $('playAll').hidden = n === 0 || playingId !== null;
  $('clear').hidden = n === 0;

  $('list').replaceChildren(
    ...queue.map((item, i) => {
      const playing = item.id === playingId;
      const row = el(document, 'li', { class: `q-item${playing ? ' is-playing' : ''}` });

      const text = el(document, 'div', { class: 'q-text' });
      const title = el(document, 'a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', class: 'q-title' }, item.title);
      const seconds = listeningSeconds(item);
      const meta = [
        item.site,
        failed.has(item.id) ? 'could not be downloaded — try again' : seconds != null ? `about ${formatListeningTime(seconds)}` : 'downloads when played',
      ];
      text.append(title, el(document, 'span', { class: 'q-meta' }, meta.join(' · ')));

      const actions = el(document, 'div', { class: 'q-actions' });
      if (playing) {
        actions.append(el(document, 'span', { class: 'pill in-use' }, 'Reading now'));
      } else {
        const read = el(document, 'button', { type: 'button', class: 'btn-sm' }, failed.has(item.id) ? '↻ Try again' : '▶ Read');
        read.addEventListener('click', () => {
          failed.delete(item.id);
          void play(item.id);
        });
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

export async function play(id: string): Promise<void> {
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
    // Could not be read *this time* — a 503, an offline moment, a permission declined. It stays
    // in the queue with a Retry; only finishing an article takes it out.
    failed.add(id);
    await skip(id);
    return;
  }
  failed.delete(id);

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
      source: { title: item.title, site: item.site, reopen: { kind: 'queue', id: item.id, url: item.url } },
      autoplay: true,
      showTips: false,
      onFinished: () => void next(id),
    })
    .catch((err) => log.error('[queue] reader failed to start:', err));
}

/** `finishedId` has been read: it leaves the queue, and the one after it starts. */
async function next(finishedId: string): Promise<void> {
  const after = idsAfter(finishedId);
  queue = await removeFromQueue(finishedId);
  await goOn(after, 'That was the last article in your queue');
}

/**
 * `failedId` could not be read now. It keeps its place in the queue — losing an article because a
 * site answered 503 is not something to recover from — and the next one is tried.
 */
async function skip(failedId: string): Promise<void> {
  await goOn(idsAfter(failedId), 'Kept in your queue to try again');
}

/** The articles queued after `id`, in order. */
function idsAfter(id: string): string[] {
  const index = queue.findIndex((q) => q.id === id);
  return index >= 0 ? queue.slice(index + 1).map((q) => q.id) : [];
}

async function goOn(candidates: string[], lastMessage: string): Promise<void> {
  // Never start something already known to have failed in this sitting: that is how "next" turns
  // into a loop through a queue of unreachable sites. But one failure further down must not end
  // the listening either — step over it to the next article that has not failed.
  const following = candidates.find((id) => !failed.has(id) && queue.some((q) => q.id === id));
  if (following) {
    toast(`Next: ${queue.find((q) => q.id === following)?.title ?? ''}`);
    await play(following);
  } else {
    await stopPlaying();
    renderList();
    toast(lastMessage);
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

/**
 * "This article's images are on its own site" — with the one button that fetches them.
 *
 * Reading a saved article should not make a request to anybody by itself; the reader decides.
 */
function imageNotice(held: number): HTMLElement {
  const row = el(document, 'p', { class: 'q-prompt article-images' });
  row.append(
    document.createTextNode(
      `${held} image${held === 1 ? '' : 's'} or media file${held === 1 ? '' : 's'} not loaded — they live on the original site, and fetching them tells it you are reading. `,
    ),
  );
  const load = el(document, 'button', { type: 'button', class: 'btn-sm' }, 'Load images');
  load.addEventListener('click', () => {
    releaseHeld($('article'));
    row.remove();
  });
  row.append(load);
  return row;
}

/** Render a saved article as a clean, safe document the reader session can run on. */
function renderArticle(item: QueueItem, article: QueuedArticle): void {
  const root = $('article');
  const nodes: Node[] = [el(document, 'h1', {}, item.title)];
  if (article.byline) nodes.push(el(document, 'p', { class: 'byline muted' }, article.byline));
  if (article.html) {
    const body = sanitised(article.html);
    const held = heldCount(body);
    if (held > 0) nodes.push(imageNotice(held));
    nodes.push(body);
  } else {
    for (const paragraph of article.text.split(/\n+/)) {
      if (paragraph.trim()) nodes.push(el(document, 'p', {}, paragraph.trim()));
    }
  }
  root.replaceChildren(...nodes);
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
    toast(`Could not read ${item.site} — ${err instanceof Error ? err.message : String(err)}. It stays in your queue.`, 'error');
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

/** Whether `id` is still in the queue (a note or history entry may outlive its queue item). */
export function inQueue(id: string): boolean {
  return queue.some((q) => q.id === id);
}

export async function initQueue(opts: { onCount: (count: number) => void }): Promise<void> {
  onCountChange = opts.onCount;
  speed = (await getSettings()).speed;
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
