/**
 * pdf.js's worker, after the built-ins it needs (polyfills.mjs, beside this file).
 *
 * pdf.js starts its worker as a module worker from `GlobalWorkerOptions.workerSrc`, which
 * src/pdf/load-pdf.ts points here. Static imports run in order, so the built-ins are in place
 * before the first line of pdf.js runs.
 */
import './polyfills.mjs';
import '../vendor/pdfjs/pdf.worker.mjs';
