/**
 * Marks into the PDF file, and out of it again.
 *
 * Marks are written as the standard annotation types — Highlight, Underline, StrikeOut, Text —
 * with a comment in `/Contents` and an appearance stream of their own, so any viewer shows them
 * exactly as drawn here rather than each guessing its own style.
 *
 * Writing always starts from the file with those four types removed, then adds the current marks.
 * They were imported as editable marks when the file was opened, so the list is the whole truth:
 * a mark deleted here is gone from the file too, and saving twice never duplicates anything.
 * Every other annotation (links, form fields, stamps, drawings) is left exactly as it was.
 *
 * pdf-lib is loaded on first use; opening and reading a PDF never pays for it.
 */
import type { PDFDict as PDFDictType, PDFDocument as PDFDocumentType, PDFObject, PDFRef as PDFRefType } from 'pdf-lib';
import { PDF_SUBTYPES, rgbOf, unionBox, type Box, type Mark } from './model';

type PdfLib = typeof import('pdf-lib');

let libPromise: Promise<PdfLib> | null = null;
function pdfLib(): Promise<PdfLib> {
  libPromise ??= import('pdf-lib');
  return libPromise;
}

const MANAGED = new Set(Object.values(PDF_SUBTYPES));

/** Why a file could not be written. The marks themselves are safe either way. */
export class PdfWriteError extends Error {}

async function load(lib: PdfLib, bytes: Uint8Array): Promise<PDFDocumentType> {
  try {
    return await lib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof lib.EncryptedPDFError) {
      throw new PdfWriteError('This PDF is password-protected, so nothing can be written into it.');
    }
    throw new PdfWriteError(`This PDF could not be rewritten: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Remove the highlights, underlines, strike-throughs and sticky notes **that Aloud imported**
 * (and their pop-ups), leaving every other annotation in the file untouched.
 *
 * "That Aloud imported" is the important part. The importer skips annotations that are hidden or
 * marked not-to-display, and any whose geometry it cannot read; stripping by subtype alone
 * therefore deleted marks that were never shown to the reader and never came back — someone
 * else's hidden review comment, silently dropped on save. The rule here has to be exactly the
 * importer's rule, so this mirrors it (model.ts: `importAnnotations`).
 *
 * Returns how many were removed, so a caller can skip saving a copy that did not change.
 */
function stripManaged(lib: PdfLib, doc: PDFDocumentType): number {
  const { PDFName, PDFArray, PDFDict, PDFRef } = lib;
  const ctx = doc.context;
  let removed = 0;

  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;

    const entries = annots.asArray();
    const dicts = entries.map((raw) => {
      const dict = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      return dict instanceof PDFDict ? dict : null;
    });
    const subtypeOf = (dict: PDFDictType | null): string => dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? '';

    const gone = new Set<PDFObject>();
    entries.forEach((raw, i) => {
      const dict = dicts[i];
      if (dict && MANAGED.has(subtypeOf(dict)) && wasImported(lib, dict, subtypeOf(dict))) gone.add(raw);
    });
    // A pop-up belongs to the markup annotation it opens from, and goes with it.
    entries.forEach((raw, i) => {
      const dict = dicts[i];
      if (subtypeOf(dict!) !== 'Popup') return;
      const parent = dict!.get(PDFName.of('Parent'));
      if (!parent || gone.has(parent)) gone.add(raw);
    });
    if (gone.size === 0) continue;

    removed += entries.filter((raw, i) => gone.has(raw) && subtypeOf(dicts[i]!) !== 'Popup').length;
    for (const raw of gone) {
      if (!(raw instanceof PDFRef)) continue;
      const appearance = (ctx.lookup(raw) as PDFDictType | undefined)?.lookupMaybe(PDFName.of('AP'), PDFDict);
      for (const state of appearance?.values() ?? []) if (state instanceof PDFRef) ctx.delete(state);
      ctx.delete(raw);
    }
    const kept = entries.filter((raw) => !gone.has(raw));
    if (kept.length) page.node.set(PDFName.of('Annots'), ctx.obj(kept));
    else page.node.delete(PDFName.of('Annots'));
  }
  return removed;
}

/**
 * The file with its highlights and notes removed, for drawing the pages under editable marks.
 * Null when there were none to remove.
 */
export async function withoutMarks(bytes: Uint8Array): Promise<Uint8Array | null> {
  const lib = await pdfLib();
  const doc = await load(lib, bytes);
  if (stripManaged(lib, doc) === 0) return null;
  return doc.save({ updateFieldAppearances: false });
}

/** The file with exactly `marks` as its highlights, underlines, strike-throughs and notes. */
export async function withMarks(bytes: Uint8Array, marks: readonly Mark[]): Promise<Uint8Array> {
  const lib = await pdfLib();
  const doc = await load(lib, bytes);
  stripManaged(lib, doc);
  const pages = doc.getPages();
  for (const mark of marks) {
    const page = pages[mark.page - 1];
    if (!page || mark.boxes.length === 0) continue;
    const ref = annotationFor(lib, doc, mark);
    const annots = page.node.lookupMaybe(lib.PDFName.of('Annots'), lib.PDFArray);
    if (annots) annots.push(ref);
    else page.node.set(lib.PDFName.of('Annots'), doc.context.obj([ref]));
  }
  return doc.save({ updateFieldAppearances: false });
}

function annotationFor(lib: PdfLib, doc: PDFDocumentType, mark: Mark): PDFRefType {
  const { PDFHexString, PDFString } = lib;
  const ctx = doc.context;
  const union = unionBox(mark.boxes);
  const pad = mark.kind === 'note' ? 0 : 1;
  const rect: Box = [union[0] - pad, union[1] - pad, union[2] + pad, union[3] + pad];
  const [r, g, b] = rgbOf(mark.color);

  const appearance = ctx.register(
    ctx.stream(appearanceOps(mark), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: rect.map(round),
      Resources: { ExtGState: { G0: { Type: 'ExtGState', BM: mark.kind === 'highlight' ? 'Multiply' : 'Normal' } } },
    }),
  );

  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: PDF_SUBTYPES[mark.kind],
    Rect: rect.map(round),
    C: [r, g, b].map((c) => round(c, 3)),
    // Print: a highlighted paper copy is the point of highlighting.
    F: 4,
    AP: { N: appearance },
    ...(mark.kind === 'note'
      ? { Name: 'Comment', Open: false }
      : { QuadPoints: mark.boxes.flatMap(([l, bt, rt, t]) => [l, t, rt, t, l, bt, rt, bt]).map((n) => round(n)) }),
  });
  dict.set(lib.PDFName.of('NM'), PDFString.of(`aloud-${mark.id}`));
  dict.set(lib.PDFName.of('T'), PDFHexString.fromText('Aloud'));
  dict.set(lib.PDFName.of('M'), PDFString.of(pdfDate(mark.updated)));
  dict.set(lib.PDFName.of('CreationDate'), PDFString.of(pdfDate(mark.created)));
  if (mark.note) dict.set(lib.PDFName.of('Contents'), PDFHexString.fromText(mark.note));
  return ctx.register(dict);
}

/** The drawing operators for a mark's appearance, in page coordinates. */
export function appearanceOps(mark: Mark): string {
  const [r, g, b] = rgbOf(mark.color).map((c) => round(c, 3));
  const fill = `${r} ${g} ${b} rg`;
  const ops: string[] = ['/G0 gs', fill];

  if (mark.kind === 'note') {
    const [l, bt, rt, t] = mark.boxes[0]!;
    const w = rt - l;
    const h = t - bt;
    ops.push(`0.25 0.25 0.25 RG 0.8 w ${n(l + 0.5)} ${n(bt + 0.5)} ${n(w - 1)} ${n(h - 1)} re B`);
    ops.push('0.25 0.25 0.25 rg');
    for (const f of [0.68, 0.5, 0.32]) ops.push(`${n(l + w * 0.2)} ${n(bt + h * f)} ${n(w * 0.6)} ${n(Math.max(0.8, h * 0.06))} re f`);
    return ops.join('\n');
  }

  for (const [l, bt, rt, t] of mark.boxes) {
    const h = t - bt;
    if (mark.kind === 'highlight') {
      ops.push(`${n(l)} ${n(bt)} ${n(rt - l)} ${n(h)} re f`);
    } else {
      const thickness = Math.max(0.6, h * 0.07);
      const y = mark.kind === 'underline' ? bt + h * 0.05 : bt + h * 0.42;
      ops.push(`${n(l)} ${n(y)} ${n(rt - l)} ${n(thickness)} re f`);
    }
  }
  return ops.join('\n');
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

const n = (value: number): string => String(round(value));

/** `D:YYYYMMDDHHmmSSZ`, the PDF date format, in UTC. */
export function pdfDate(ms: number): string {
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * Would `importAnnotations` have turned this annotation into an editable mark?
 *
 * Hidden (flag bit 2) and NoView (bit 6) annotations are skipped by the importer, as are ones
 * whose quad points or rectangle it cannot use. Anything it skipped is somebody else's and stays.
 */
function wasImported(lib: PdfLib, dict: PDFDictType, subtype: string): boolean {
  const { PDFName, PDFNumber, PDFArray } = lib;
  const flags = dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0;
  const HIDDEN = 2;
  const NO_VIEW = 32;
  if ((flags & HIDDEN) !== 0 || (flags & NO_VIEW) !== 0) return false;

  const numbers = (name: string): number[] =>
    (dict.lookupMaybe(PDFName.of(name), PDFArray)?.asArray() ?? [])
      .map((v) => (v instanceof PDFNumber ? v.asNumber() : Number.NaN))
      .filter((n) => Number.isFinite(n));

  // A sticky note is placed by its rectangle; a text markup by its quad points, falling back to
  // the rectangle — the same order the importer uses.
  if (subtype === 'Text') return numbers('Rect').length >= 4;
  return numbers('QuadPoints').length >= 8 || numbers('Rect').length >= 4;
}
