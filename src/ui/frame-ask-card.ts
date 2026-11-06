/**
 * The card on a page whose article is in a frame from another site Aloud may not read yet: what
 * it found, and a button (Aloud's own page, entrypoints/frame-ask) that asks for that site. Its own
 * closed shadow root, at the bottom of the window where the reading bar would be.
 */
import { browser } from 'wxt/browser';

const HOST_ID = 'aloud-frame-ask';

export function showFrameAskCard(doc: Document, ticket: string, site: string): void {
  removeFrameAskCard(doc);
  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .card { pointer-events: auto; box-sizing: border-box; max-width: min(560px, calc(100vw - 24px));
      display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 16px; border-radius: 16px;
      background: rgba(28, 28, 33, 0.97); color: #f2f2f5; border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); font: 13.5px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .text { flex: 1 1 auto; min-width: 0; }
    .text b { font-weight: 650; }
    iframe { flex: none; width: 96px; height: 34px; border: 0; background: transparent; color-scheme: normal; }
    .close { flex: none; width: 30px; height: 30px; border: 0; border-radius: 50%; cursor: pointer;
      background: transparent; color: #b8b8c4; font: 18px/1 system-ui, sans-serif; }
    .close:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
  `;
  const card = doc.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Aloud');
  const text = doc.createElement('div');
  text.className = 'text';
  text.append('The text of this page is in an embedded page from ');
  const b = doc.createElement('b');
  b.textContent = site;
  text.append(b, '. Aloud needs your permission to read it.');
  const frame = doc.createElement('iframe');
  frame.title = `Read the embedded page from ${site}`;
  frame.src = `${browser.runtime.getURL('/frame-ask.html')}#${ticket}`;
  const close = doc.createElement('button');
  close.className = 'close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => removeFrameAskCard(doc));
  card.append(text, frame, close);
  root.append(style, card);
  (doc.body ?? doc.documentElement).append(host);
}

export function removeFrameAskCard(doc: Document): void {
  doc.getElementById(HOST_ID)?.remove();
}
