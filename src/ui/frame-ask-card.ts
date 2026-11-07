/**
 * The card on a page whose article is in a frame from another site Aloud may not read yet: what
 * it found, and a button (Aloud's own page, entrypoints/frame-ask) that asks for that site. Its own
 * closed shadow root, at the bottom of the window where the reading bar would be.
 *
 * Styled through each element's `style`, not a <style> element: claude.ai's policy allows styles by
 * nonce only, and Firefox applies that to a content script's <style> too (blocked, so the card was
 * drawn unstyled). Styles set from script are not covered by it.
 */
import { browser } from 'wxt/browser';

const HOST_ID = 'aloud-frame-ask';

function styled<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, css: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.style.cssText = css;
  return el;
}

export function showFrameAskCard(doc: Document, ticket: string, site: string): void {
  removeFrameAskCard(doc);
  const host = styled(doc, 'div', 'all: initial; position: fixed; z-index: 2147483647; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; pointer-events: none;');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const card = styled(doc, 'div',
    'pointer-events: auto; box-sizing: border-box; max-width: min(560px, calc(100vw - 24px)); display: flex; align-items: center; gap: 12px; ' +
    'padding: 10px 10px 10px 16px; border-radius: 16px; background: rgba(28, 28, 33, 0.97); color: #f2f2f5; ' +
    'border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); ' +
    'font: 13.5px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Aloud');
  const text = styled(doc, 'div', 'flex: 1 1 auto; min-width: 0;');
  text.append('The text of this page is in an embedded page from ');
  const b = styled(doc, 'b', 'font-weight: 650;');
  b.textContent = site;
  text.append(b, '. Aloud needs your permission to read it.');
  const frame = styled(doc, 'iframe', 'flex: none; width: 96px; height: 34px; border: 0; background: transparent; color-scheme: normal;');
  frame.title = `Read the embedded page from ${site}`;
  frame.src = `${browser.runtime.getURL('/frame-ask.html')}#${ticket}`;
  const close = styled(doc, 'button', 'flex: none; width: 30px; height: 30px; border: 0; border-radius: 50%; cursor: pointer; background: transparent; color: #b8b8c4; font: 18px/1 system-ui, sans-serif;');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => removeFrameAskCard(doc));
  card.append(text, frame, close);
  root.append(card);
  (doc.body ?? doc.documentElement).append(host);
}

export function removeFrameAskCard(doc: Document): void {
  doc.getElementById(HOST_ID)?.remove();
}
