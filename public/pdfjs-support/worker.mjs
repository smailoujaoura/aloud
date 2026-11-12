/**
 * pdf.js's worker, after the built-ins it needs (polyfills.mjs, beside this file).
 *
 * pdf.js starts its worker as a module worker from `GlobalWorkerOptions.workerSrc`, which
 * src/pdf/load-pdf.ts points here. Static imports run in order, so the built-ins are in place
 * before the first line of pdf.js runs.
 *
 * It also re-exports the worker: when a module worker cannot start, pdf.js imports `workerSrc` on
 * the page and runs its `WorkerMessageHandler` there instead, which must be found here.
 */
import './polyfills.mjs';
export * from '../vendor/pdfjs/pdf.worker.mjs';
