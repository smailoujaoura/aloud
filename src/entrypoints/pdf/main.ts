/**
 * Aloud's PDF reader page.
 *
 * A PDF in a browser tab is unreadable to an extension: Chromium renders it inside a plugin
 * `<embed>` whose document has no text at all (`document.body.innerText.length === 0`), and
 * Firefox renders it in a privileged pdf.js viewer no content script may touch. That is why
 * "read this page aloud" on a PDF used to say *"This page doesn't look like an article."*
 *
 * So Aloud opens the PDF here instead: this page gets the file's bytes, extracts its text with
 * pdf.js, rebuilds it as ordinary HTML — headings, paragraphs, lists, page markers — and then
 * runs the **same** reader session used on any web page. Sentence highlighting, tap-to-seek,
 * scroll modes, the control bar and every voice work unchanged, because as far as the session is
 * concerned this is just a well-structured article.
 *
 * Where the bytes come from, in order of preference:
 *   1. a **job** handed over by the background, which fetched the file under `activeTab` (and,
 *      for `file://` on Chromium, under "Allow access to file URLs");
 *   2. a **`src` URL** this page can fetch itself (same-origin extension assets, http(s) URLs
 *      the user pasted);
 *   3. the **file picker / drop target**, which needs no permission anywhere and is the answer
 *      on Firefox, where add-ons cannot read local files at all.
 */
import { ReaderSession, type KnownArticle } from '@/content/session';
import { readPdf, type LoadedPdf, type PdfPageView, type PdfRenderer } from '@/pdf/load-pdf';
import { takePdf } from '@/pdf/handoff';
import { buildTextLayer } from '@/pdf/page-view';
import { titleIsInBody, type PdfBlock, type PdfLineBox } from '@/pdf/text-layout';
import { getSettings, watchSettings, type PdfView } from '@/shared/settings';
import { applyTheme, watchSystemTheme } from '@/ui/theme';
import { log } from '@/shared/log';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const job = params.get('job');
const src = params.get('src');
/** Set by the background when it already knows why it could not read the file itself. */
const reason = params.get('reason');

// ---- status ----------------------------------------------------------------

function showStatus(text: string, progress?: number): void {
  $('status').hidden = false;
  $('picker').hidden = true;
  $('statusLine').textContent = text;
  $('statusBar').style.width = `${Math.round((progress ?? 0) * 100)}%`;
}

/**
 * Offer the picker, explaining *why* it is being offered.
 *
 * The explanation matters: "choose a file" in front of someone who just clicked the toolbar
 * button on a PDF they already have open looks broken unless it says what stopped it.
 */
function showPicker(title: string, hint: string, note = '', action?: PickerAction): void {
  $('status').hidden = true;
  $('picker').hidden = false;
  $('pickerTitle').textContent = title;
  $('pickerHint').textContent = hint;
  const noteEl = $('pickerNote');
  noteEl.textContent = note;
  noteEl.hidden = note === '';

  const button = $<HTMLButtonElement>('pickerAction');
  button.hidden = !action;
  if (!action) return;
  button.textContent = action.label;
  button.onclick = () => void action.run();
}

interface PickerAction {
  label: string;
  /** Must run straight off the click: `permissions.request` needs the user gesture. */
  run: () => Promise<void>;
}

// ---- rendering: reflowed text ----------------------------------------------

/**
 * Rebuild the PDF as HTML.
 *
 * Headings become real headings so the reader's section navigation works, and page boundaries
 * become `<hr>` elements that carry their label in a `::after` — markup with no text of its own,
 * so "page 4 of 12" is never read aloud in the middle of a sentence.
 */
function renderReflow(doc: LoadedPdf): void {
  const article = $('article');
  article.replaceChildren(...titleNodes(doc));

  let page = 0;
  let list: HTMLUListElement | null = null;

  for (const block of doc.blocks) {
    if (block.page !== page) {
      if (page !== 0) article.append(pageBreak(block.page));
      page = block.page;
      list = null;
    }
    if (block.kind === 'list-item') {
      if (!list) {
        list = document.createElement('ul');
        article.append(list);
      }
      const li = document.createElement('li');
      li.textContent = block.text;
      list.append(li);
      continue;
    }
    list = null;
    article.append(elementFor(block));
  }
}

function elementFor(block: PdfBlock): HTMLElement {
  if (block.kind === 'heading') {
    const el = document.createElement(`h${Math.min(3, Math.max(2, (block.level ?? 2) + 1))}`);
    el.textContent = block.text;
    return el;
  }
  const p = document.createElement('p');
  p.textContent = block.text;
  return p;
}

function pageBreak(page: number): HTMLElement {
  const hr = document.createElement('hr');
  hr.className = 'page-break';
  hr.dataset.page = `page ${page}`;
  hr.setAttribute('aria-hidden', 'true');
  return hr;
}

function titleHeading(title: string): HTMLElement {
  const h1 = document.createElement('h1');
  h1.textContent = title;
  return h1;
}

/**
 * The document's own `<h1>`, unless the title is already on the page.
 *
 * A title taken from the PDF's metadata is text the body does not contain, so it earns a heading.
 * A title `pickTitle` lifted from the first page is still in `doc.blocks`; adding it again made
 * the reader say it twice — for most PDFs, since few carry a usable metadata title.
 */
function titleNodes(doc: LoadedPdf): HTMLElement[] {
  return titleIsInBody(doc.title, doc.blocks) ? [] : [titleHeading(doc.title)];
}

// ---- rendering: the pages themselves ---------------------------------------

/** Page images are drawn only near the viewport; this much beyond it, in viewport heights. */
const RENDER_MARGIN = '150% 0px';

/** Widest a page is drawn, so a big monitor does not render a poster-sized canvas. */
const MAX_PAGE_WIDTH = 1000;

interface PageSlot {
  holder: HTMLElement;
  canvas: HTMLCanvasElement;
  view: PdfPageView;
  drawn: boolean;
}

/**
 * Draw the document as pages, with the text layer over each one.
 *
 * The text layer is built for every page up front — it is what the reader reads, so it cannot
 * wait for a scroll — while the *images* are drawn only near the viewport and freed again once
 * they are well away from it. A 500-page book at device resolution is gigabytes of canvas if
 * every page is kept, and the reader is expected to run for an hour.
 */
function renderPages(doc: LoadedPdf, renderer: PdfRenderer, scale: number): Promise<void> {
  const article = $('article');
  article.replaceChildren(...titleNodes(doc));

  const byPage = blocksByPage(doc.blocks);
  const slots = new WeakMap<Element, PageSlot>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = slots.get(entry.target);
        if (!slot) continue;
        if (entry.isIntersecting) draw(slot);
        else release(slot);
      }
    },
    { rootMargin: RENDER_MARGIN },
  );
  pageObserver?.disconnect();
  pageObserver = observer;

  const built = Array.from({ length: renderer.pageCount }, async (_, i) => {
    const pageNumber = i + 1;
    const view = await renderer.view(pageNumber, scale);

    const holder = document.createElement('div');
    holder.className = 'pdf-page';
    holder.style.width = `${view.width}px`;
    holder.style.height = `${view.height}px`;
    // Screen readers get the text layer, which is real text; the canvas is decoration.
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    holder.append(canvas);

    const layer = buildTextLayer(view, byPage.get(pageNumber) ?? []);
    holder.append(layer.el);

    slots.set(holder, { holder, canvas, view, drawn: false });
    return { holder, finish: layer.finish, pageNumber };
  });

  function draw(slot: PageSlot): void {
    if (slot.drawn) return;
    slot.drawn = true;
    void slot.view.render(slot.canvas).catch((err) => {
      // A cancelled render is the normal outcome of scrolling past a page mid-draw.
      if (!slot.drawn) return;
      log.warn('[pdf] page render failed:', err);
    });
  }

  /** Give the memory back. The page keeps its size, so nothing below it moves. */
  function release(slot: PageSlot): void {
    if (!slot.drawn) return;
    slot.drawn = false;
    slot.view.cancel();
    slot.canvas.width = 0;
    slot.canvas.height = 0;
  }

  return Promise.all(built).then((pages) => {
    for (const { holder } of pages) article.append(holder);
    // Scaling the lines needs measurements, so it happens once every page is in the document.
    for (const { finish } of pages) finish();
    // Observed last, so the first callback sees pages that are laid out and can be drawn.
    for (const { holder } of pages) observer.observe(holder);
  });
}

/** The lines of each block, split by the page they sit on — a block can straddle a page break. */
function blocksByPage(blocks: PdfBlock[]): Map<number, Array<{ block: PdfBlock; lines: PdfLineBox[] }>> {
  const out = new Map<number, Array<{ block: PdfBlock; lines: PdfLineBox[] }>>();
  for (const block of blocks) {
    let current: PdfLineBox[] = [];
    let page = -1;
    const flush = (): void => {
      if (current.length === 0) return;
      const list = out.get(page) ?? [];
      list.push({ block, lines: current });
      out.set(page, list);
      current = [];
    };
    for (const line of block.lines) {
      if (line.page !== page) {
        flush();
        page = line.page;
      }
      current.push(line);
    }
    flush();
  }
  return out;
}

/** Fit the widest page to the window, never enlarging past MAX_PAGE_WIDTH. */
async function fitScale(renderer: PdfRenderer): Promise<number> {
  const first = await renderer.view(1, 1);
  const available = Math.min(MAX_PAGE_WIDTH, Math.max(320, window.innerWidth - 48));
  return available / first.width;
}

// ---- loading ---------------------------------------------------------------

let session: ReaderSession | null = null;
let renderer: PdfRenderer | null = null;
let pageObserver: IntersectionObserver | null = null;

async function present(source: Parameters<typeof readPdf>[0], name: string): Promise<void> {
  showStatus('Reading the PDF…', 0.02);
  const view: PdfView = (await getSettings().catch(() => null))?.pdfView ?? 'pages';

  let doc: LoadedPdf;
  try {
    doc = await readPdf(source, {
      keepOpen: view === 'pages',
      onProgress: ({ page, pageCount }) => {
        showStatus(`Reading the PDF… page ${page} of ${pageCount}`, page / Math.max(1, pageCount));
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[pdf] failed to read:', message);
    showPicker(
      'That PDF could not be read',
      `Aloud could not extract text from ${name}: ${message}`,
      'Scanned PDFs contain images rather than text, and have nothing to read aloud.',
    );
    return;
  }

  if (doc.blocks.length === 0) {
    doc.renderer?.destroy();
    showPicker(
      'No text in this PDF',
      `${name} has ${doc.pageCount} page(s) but no extractable text.`,
      'It is most likely a scan. Running OCR on it first would make it readable.',
    );
    return;
  }

  document.title = `${doc.title} — Aloud`;
  renderer?.destroy();
  renderer = doc.renderer;

  // Revealed *before* the pages are laid out: positioning the text layer needs real
  // measurements, and a `hidden` ancestor measures every box as zero.
  $('picker').hidden = true;
  $('doc').hidden = false;

  if (renderer) {
    showStatus('Drawing the pages…', 0.98);
    document.body.classList.add('pages-view');
    await renderPages(doc, renderer, await fitScale(renderer));
  } else {
    document.body.classList.remove('pages-view');
    renderReflow(doc);
  }

  $('status').hidden = true;
  log.info(
    `[pdf] ${name}: ${doc.pageCount} page(s) → ${doc.blocks.length} block(s), ${view} view`,
  );

  // From here on it is an ordinary article, and the ordinary reader handles it.
  await session?.dispose();
  session = new ReaderSession();
  await session.begin('article', { knownArticle: knownArticle(doc, name) }).catch((err) =>
    log.error('[pdf] reader failed to start:', err),
  );
}

/**
 * Tell the reader what this document is, instead of letting Readability re-derive it.
 *
 * We already know: the layout pass resolved the columns and the reading order, and built the DOM
 * from that. Readability looking at the result could only disagree — and in the page view it
 * would be looking at absolutely-positioned transparent lines, which is not what it is for.
 */
function knownArticle(doc: LoadedPdf, name: string): KnownArticle {
  const root = $('article');
  return {
    root,
    title: doc.title,
    // Must match what is on the page, or alignment hunts for a title that was never rendered.
    text: [...(titleIsInBody(doc.title, doc.blocks) ? [] : [doc.title]), ...doc.blocks.map((b) => b.text)].join('\n'),
    lang: document.documentElement.lang || 'en',
    // This page's own URL carries a one-off job id, so it cannot identify the document. The file
    // name plus page count does, well enough to resume the same report opened again tomorrow.
    key: `pdf:${name}:${doc.pageCount}`,
  };
}

/**
 * Collect the bytes the background fetched when the user activated Aloud on the PDF tab.
 *
 * They come through IndexedDB rather than a message because Chromium serialises extension
 * messages as JSON, which would turn the ArrayBuffer into an empty object.
 */
async function loadJob(id: string): Promise<boolean> {
  try {
    const record = await takePdf(id);
    if (!record) {
      log.warn('[pdf] no hand-off record for job', id);
      return false;
    }
    await present({ kind: 'data', data: record.data }, record.name || record.url);
    return true;
  } catch (err) {
    log.warn('[pdf] job hand-off failed:', err);
    return false;
  }
}

/** Fetch a URL this page is allowed to read (extension assets, and http(s) with permission). */
async function loadUrl(url: string): Promise<boolean> {
  try {
    showStatus('Fetching the PDF…', 0.01);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await present({ kind: 'data', data: await res.arrayBuffer() }, fileNameOf(url));
    return true;
  } catch (err) {
    log.warn('[pdf] direct fetch failed:', err);
    return false;
  }
}

function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || url;
  } catch {
    return url;
  }
}

/**
 * Ask for permission to download this one PDF, and open it if granted.
 *
 * A PDF linked from a website is fetched *from* that website, which is a cross-origin request —
 * so without host permission it fails CORS no matter how the file is served, and `activeTab` is
 * no help because the tab is showing the browser's own PDF viewer rather than a page Aloud was
 * invoked on. Asking for the single origin, at the moment it is needed and from the user's own
 * click, is the smallest thing that works; a blanket "read all your data on every website" at
 * install time would not be an honest trade for a reader that touches nothing until asked.
 */
async function requestOriginAndOpen(url: string): Promise<void> {
  const origin = originPatternOf(url);
  if (!origin) return;

  let granted = false;
  try {
    granted = await browser.permissions.request({ origins: [origin] });
  } catch (err) {
    log.warn('[pdf] permission request failed:', err);
  }
  if (!granted) {
    showPicker(
      `Open ${fileNameOf(url)}`,
      'Without permission for that site, Aloud cannot download the file itself.',
      'You can still save the PDF and choose it here — it is read entirely on this device either way.',
    );
    return;
  }
  if (!(await loadUrl(url))) {
    showPicker(
      `Open ${fileNameOf(url)}`,
      'Permission was granted, but the file still could not be downloaded.',
      'The site may require a login, or the link may have expired. Saving the PDF and choosing it here always works.',
    );
  }
}

/** `https://example.com/page.pdf` -> `https://example.com/*`, the narrowest useful grant. */
function originPatternOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') return null;
    return `${protocol}//${hostname}/*`;
  } catch {
    return null;
  }
}

/** What to tell the user when nothing could be loaded automatically. */
function fallbackToPicker(): void {
  const name = src ? fileNameOf(src) : '';
  const isFile = src?.startsWith('file:');
  const gecko = navigator.userAgent.includes('Firefox');

  if (isFile && gecko) {
    showPicker(
      name || 'Open the PDF',
      'Firefox does not let add-ons read files from your disk, so Aloud cannot open this PDF on its own.',
      'Choose the same file here and it will be read aloud — nothing leaves your device either way.',
    );
    return;
  }
  if (isFile) {
    showPicker(
      name || 'Open the PDF',
      'Aloud is not allowed to read local files yet, so it cannot open this PDF on its own.',
      'Turn on "Allow access to file URLs" for Aloud on the extensions page (chrome://extensions), ' +
        'or choose the file here.',
    );
    return;
  }

  const origin = src ? originPatternOf(src) : null;
  if (src && origin) {
    const host = new URL(src).hostname;
    showPicker(
      `Open ${name}`,
      `Aloud needs your permission to download this file from ${host}.`,
      'It is downloaded to this device and read here. Nothing is uploaded, and the permission ' +
        'covers only that site.',
      { label: `Allow and open`, run: () => requestOriginAndOpen(src) },
    );
    return;
  }

  showPicker(
    name ? `Open ${name}` : 'Open a PDF',
    reason
      ? `Aloud could not fetch this PDF (${reason}).`
      : 'Choose a PDF file to read it aloud. Everything stays on this device.',
  );
}

// ---- picker + drag and drop ------------------------------------------------

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void openFile(file);
});

async function openFile(file: File): Promise<void> {
  showStatus(`Reading ${file.name}…`, 0.02);
  await present({ kind: 'data', data: await file.arrayBuffer() }, file.name);
}

document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  document.body.classList.add('drop-hint');
});
document.addEventListener('dragleave', () => document.body.classList.remove('drop-hint'));
document.addEventListener('drop', (e) => {
  document.body.classList.remove('drop-hint');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault();
  void openFile(file);
});

window.addEventListener('pagehide', () => {
  void session?.dispose();
  pageObserver?.disconnect();
  renderer?.destroy();
});

// ---- entry -----------------------------------------------------------------

/**
 * Paint this page in the user's theme, and keep painting it: the theme can be changed from the
 * settings page while a document is open here, and the control bar in this very page follows
 * that change immediately — the paper around it has to as well.
 */
void (async () => {
  const theme = (await getSettings().catch(() => null))?.theme ?? 'system';
  applyTheme(document, theme);
  watchSystemTheme(() => void getSettings().then((s) => applyTheme(document, s.theme)));
  watchSettings((s) => applyTheme(document, s.theme));
})();

void (async () => {
  if (job && (await loadJob(job))) return;
  if (src && (await loadUrl(src))) return;
  fallbackToPicker();
})();
