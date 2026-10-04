/**
 * Reading a PDF's text with pdf.js, from inside the extension.
 *
 * pdf.js is vendored under `public/vendor/pdfjs/` and imported **by URL at run time**, exactly
 * like ONNX Runtime (see `engine/ort-loader.ts`). Bundling it would inline its 1.3 MB worker into
 * a page bundle and fight with Vite over the worker's own `import.meta.url`; loading it from the
 * extension origin also means the worker is same-origin and runs under the extension CSP.
 *
 * Two things come out of here, and the reader page uses one or both:
 *
 *  - the **text**, laid out into a readable document (`pdf/text-layout.ts`), which is what the
 *    reflowed view shows and what every sentence is planned from;
 *  - a **renderer**, kept open over the parsed document, so the reader can draw the real pages to
 *    canvases and overlay an invisible text layer on them. Reading a PDF *as the PDF* is not
 *    possible in either browser's own viewer — Chromium puts it in an internal plugin frame and
 *    Firefox in a privileged pdf.js viewer, neither of which an extension may touch — so drawing
 *    the pages ourselves is the only way to keep the document looking like itself.
 *
 * Keeping the renderer open holds the pdf.js worker and the parsed document in memory, so the
 * caller must `destroy()` it. `readPdf` without `keepOpen` tears everything down as before.
 */
import type { PdfJsAnnotation } from './annotations/model';
import { layoutPdfText, type PdfOutline, type PdfPageInput, type PdfTextItem } from './text-layout';
import { ensureStreamIteration } from './stream-iteration';

/** Where the bytes come from. `url` is fetched by whoever can reach it; `data` is already read. */
export type PdfSource = { kind: 'url'; url: string } | { kind: 'data'; data: ArrayBuffer };

export interface PdfLoadProgress {
  /** Pages whose text has been extracted so far. */
  page: number;
  pageCount: number;
}

export interface LoadedPdf extends PdfOutline {
  pageCount: number;
  /** Present only when `keepOpen` was asked for. The caller owns it and must `destroy()` it. */
  renderer: PdfRenderer | null;
  /**
   * Highlights, underlines, strike-throughs and sticky notes already in the file, by page.
   * Collected only with `keepOpen`: the page view is where they can be shown and edited.
   */
  annotations: Array<{ page: number; annotations: PdfJsAnnotation[] }>;
}

export interface ReadPdfOptions {
  onProgress?: (p: PdfLoadProgress) => void;
  /** Keep the document open so pages can be drawn. Costs memory until `renderer.destroy()`. */
  keepOpen?: boolean;
}

/** A page prepared at one scale: its size, how to draw it, and where its text sits. */
export interface PdfPageView {
  /** CSS pixels at the requested scale. */
  width: number;
  height: number;
  /** PDF user space -> CSS pixels within this page, rotation included. */
  toViewport(x: number, y: number): [number, number];
  /** CSS pixels within this page -> PDF user space. */
  toPdf(x: number, y: number): [number, number];
  /** Draw the page into `canvas`, sizing it for `devicePixelRatio`. */
  render(canvas: HTMLCanvasElement): Promise<void>;
  /** Abort an in-flight render (the page scrolled away, or the scale changed). */
  cancel(): void;
}

export interface PdfRenderer {
  pageCount: number;
  view(pageNumber: number, scale: number): Promise<PdfPageView>;
  destroy(): void;
}

interface PdfJsModule {
  getDocument(src: Record<string, unknown>): PdfLoadingTaskLike;
  GlobalWorkerOptions: { workerSrc: string };
}

/** `destroy()` lives on the *loading task* in pdf.js, not on the document proxy. */
interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void>;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  getMetadata(): Promise<{ info?: { Title?: string } }>;
}

interface PdfViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
  convertToPdfPoint(x: number, y: number): [number, number];
}

interface RenderTaskLike {
  promise: Promise<void>;
  cancel(): void;
}

interface PdfPageLike {
  getViewport(o: { scale: number }): PdfViewportLike;
  getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>;
  getAnnotations(): Promise<PdfJsAnnotation[]>;
  render(o: Record<string, unknown>): RenderTaskLike;
  cleanup(): void;
}

/** Resolve a packaged asset from the extension origin, without needing `browser.*`. */
function vendorUrl(file: string): string {
  return new URL(`vendor/pdfjs/${file}`, location.origin + '/').href;
}

let modulePromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (modulePromise) return modulePromise;
  ensureStreamIteration(); // pdf.js reads text with `for await`; Chromium 120 cannot (stream-iteration.ts)
  modulePromise = (async () => {
    const url = vendorUrl('pdf.min.mjs');
    const mod = (await import(/* @vite-ignore */ url)) as unknown as PdfJsModule;
    if (!mod?.getDocument) throw new Error(`pdf.js loaded from ${url} but exposes no getDocument()`);
    // Without this pdf.js tries to fetch its worker from a CDN, which our CSP blocks.
    mod.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs');
    return mod;
  })().catch((err) => {
    modulePromise = null; // let a retry start from scratch
    throw err;
  });
  return modulePromise;
}

/**
 * Extract a readable document from a PDF.
 *
 * `onProgress` is called per page: a 300-page report takes a while, and a reader that looks
 * frozen while it works is the thing users complain about.
 */
export async function readPdf(source: PdfSource, opts: ReadPdfOptions = {}): Promise<LoadedPdf> {
  const { onProgress, keepOpen = false } = opts;
  const pdfjs = await loadPdfJs();

  const task = pdfjs.getDocument({
    ...(source.kind === 'url' ? { url: source.url } : { data: new Uint8Array(source.data) }),
    ...documentOptions(),
  });
  const doc = await task.promise;

  let ok = false;
  try {
    const metadata = await doc.getMetadata().catch(() => null);
    const pages: PdfPageInput[] = [];
    const annotations: LoadedPdf['annotations'] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        pageNumber: n,
        width: viewport.width,
        height: viewport.height,
        items: content.items.map(toItem).filter((it): it is PdfTextItem => it !== null),
      });
      if (keepOpen) {
        const found = await page.getAnnotations().catch(() => [] as PdfJsAnnotation[]);
        if (found.length) annotations.push({ page: n, annotations: found });
      }
      page.cleanup();
      onProgress?.({ page: n, pageCount: doc.numPages });
    }

    const outline = layoutPdfText(pages, { metadataTitle: metadata?.info?.Title });
    ok = true;
    return {
      ...outline,
      pageCount: doc.numPages,
      renderer: keepOpen ? makeRenderer(doc, task) : null,
      annotations,
    };
  } finally {
    // Tears down the worker and frees the parsed document. Skipped when the caller asked to keep
    // rendering — it owns the renderer from here, and destroys it when the view changes or the
    // page goes away.
    if (!keepOpen || !ok) void task.destroy().catch(() => undefined);
  }
}

function documentOptions(): Record<string, unknown> {
  return {
    // No scripting, ever. Fonts are drawn from glyph outlines rather than injected @font-face
    // rules, which renders the same and keeps the CSP surface small.
    isEvalSupported: false,
    disableFontFace: true,
    enableXfa: false,
    // Base-14 fonts and the predefined CJK encodings, vendored alongside pdf.js. Without these a
    // page that references Helvetica or a CJK encoding is drawn with substituted glyphs.
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    cMapUrl: vendorUrl('cmaps/'),
    cMapPacked: true,
  };
}

/**
 * Open `data` for drawing only — no text extraction. Used to draw the pages from a copy of the
 * file with its highlights taken out, once they have become editable marks.
 */
export async function openRenderer(data: Uint8Array): Promise<PdfRenderer> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data, ...documentOptions() });
  try {
    return makeRenderer(await task.promise, task);
  } catch (err) {
    void task.destroy().catch(() => undefined);
    throw err;
  }
}

function makeRenderer(doc: PdfDocumentLike, task: PdfLoadingTaskLike): PdfRenderer {
  // pdf.js page proxies are cheap to re-fetch but not free, and a scroll of a long document asks
  // for the same page repeatedly.
  const pages = new Map<number, Promise<PdfPageLike>>();
  let destroyed = false;

  return {
    pageCount: doc.numPages,

    async view(pageNumber: number, scale: number): Promise<PdfPageView> {
      let pending = pages.get(pageNumber);
      if (!pending) {
        pending = doc.getPage(pageNumber);
        pages.set(pageNumber, pending);
      }
      const page = await pending;
      const viewport = page.getViewport({ scale });
      let task: RenderTaskLike | null = null;

      return {
        width: viewport.width,
        height: viewport.height,
        toViewport: (x, y) => viewport.convertToViewportPoint(x, y),
        toPdf: (x, y) => viewport.convertToPdfPoint(x, y),
        cancel() {
          try {
            task?.cancel();
          } catch {
            /* already finished */
          }
          task = null;
        },
        async render(canvas: HTMLCanvasElement): Promise<void> {
          if (destroyed) return;
          // Draw at device resolution and let CSS scale it back down, or the text on a HiDPI
          // screen is visibly soft next to the crisp DOM around it.
          const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
          canvas.width = Math.round(viewport.width * dpr);
          canvas.height = Math.round(viewport.height * dpr);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('could not get a 2d context for the PDF page');
          task = page.render({
            canvasContext: ctx,
            viewport,
            transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
          });
          await task.promise;
          task = null;
        },
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      pages.clear();
      void task.destroy().catch(() => undefined);
    },
  };
}

/** pdf.js text item -> the minimal shape `text-layout` works with. Marked-content items have no `str`. */
function toItem(raw: Record<string, unknown>): PdfTextItem | null {
  if (typeof raw.str !== 'string') return null;
  const transform = raw.transform as number[] | undefined;
  if (!transform || transform.length < 6) return null;
  // Rotated runs are page furniture — the arXiv stamp down the left margin, "DRAFT" watermarks,
  // sideways table headers. Laid out by baseline they interleave with the body text and produce
  // sentences like "arXiv:1706.03762v7 [cs.CL]best models from the literature". Skip them: a
  // text matrix that shears more than a little is not part of the reading flow. (Italics shear
  // only slightly, and stay.)
  const [a, b, c, d] = transform as [number, number, number, number];
  const shear = Math.max(Math.abs(b) / (Math.abs(a) || 1), Math.abs(c) / (Math.abs(d) || 1));
  if (shear > 0.4) return null;
  return {
    str: raw.str,
    x: transform[4]!,
    y: transform[5]!,
    width: typeof raw.width === 'number' ? raw.width : 0,
    height: typeof raw.height === 'number' && raw.height > 0 ? raw.height : Math.abs(transform[3]!) || 10,
    fontName: typeof raw.fontName === 'string' ? raw.fontName : undefined,
    hasEOL: raw.hasEOL === true,
  };
}
