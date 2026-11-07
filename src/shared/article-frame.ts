/**
 * A frame Aloud was asked to read: the article a page shows in an embedded page from another site
 * (a Claude artifact; shared/frame-article.ts). The background marks the frame before the reader
 * and the notes start there (entrypoints/background.ts: activate), with the address of the page
 * around it: the frame's own address is not one to go back to (claude.ai's answers 403 opened
 * alone), so the Library reopens the page.
 */
interface Marked {
  __aloudArticleFrame?: { pageUrl?: string };
}

/** Is this frame one Aloud reads (not an ad or a widget inside the page)? */
export function isArticleFrame(): boolean {
  return window.top !== window && !!(window as unknown as Marked).__aloudArticleFrame;
}

/** The address to go back to for what is read here: the page around a frame article, or this one. */
export function readingPageUrl(): string {
  const page = (window as unknown as Marked).__aloudArticleFrame?.pageUrl;
  return window.top !== window && page ? page : location.href;
}
