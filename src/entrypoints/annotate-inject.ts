/**
 * Content script for highlights and notes on web pages (src/annotate/). Injected with the reader,
 * by the "save to notes" shortcut or "Highlight selection" menu, when the Library opens a note, and
 * by itself on the sites listed in settings once those sites are granted.
 *
 * Idempotent: a second injection only hands its message to the running annotator.
 */
import { browser } from 'wxt/browser';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { PageAnnotator } from '@/annotate/annotator';
import { log } from '@/shared/log';

interface AnnotateGlobal {
  __aloudAnnotator?: Promise<PageAnnotator>;
}

export default defineUnlistedScript(() => {
  // Frames are left alone: notes belong to the page you are reading, not to its ads and embeds.
  if (window.top !== window) return;
  const w = window as unknown as AnnotateGlobal;
  if (w.__aloudAnnotator) return;

  w.__aloudAnnotator = (async () => {
    const annotator = new PageAnnotator();
    await annotator.start();
    const { shown, missing } = annotator.counts;
    if (shown || missing) log.info(`[notes] ${shown} highlight(s) on this page${missing ? `, ${missing} not found` : ''}`);
    return annotator;
  })();

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; id?: string; color?: string; openNote?: boolean };
    if (m?.type === 'annotate-save-selection') {
      return w.__aloudAnnotator!.then((a) => a.saveSelection(m.color, m.openNote === true)).then((note) => ({ saved: !!note }));
    }
    if (m?.type === 'annotate-reveal' && m.id) {
      // The page may still be filling in its content; give the passage a few chances to appear.
      return w.__aloudAnnotator!.then(async (a) => {
        for (let attempt = 0; attempt < 6; attempt++) {
          if (a.reveal(m.id!)) return { revealed: true };
          await new Promise((r) => setTimeout(r, 500));
        }
        return { revealed: false };
      });
    }
    return false;
  });
});
