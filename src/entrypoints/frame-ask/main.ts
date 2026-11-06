/**
 * The "Read it" button on a page whose article is in a frame from another site (a Claude
 * artifact). Pressing it asks the browser for that site, then the background starts the reader in
 * the frame. A page of Aloud's own, shown in the card's frame, because the browser shows its
 * permission prompt only for a click in one of the extension's pages.
 *
 * It acts only on a one-time ticket the background issued for this tab (entrypoints/background.ts:
 * readInFrame), so a site that embeds this page cannot make it ask for anything.
 */
import { browser } from 'wxt/browser';

const ticket = location.hash.slice(1);
const button = document.getElementById('go') as HTMLButtonElement;
let pattern: string | null = null;

void browser.runtime
  .sendMessage({ type: 'frame-ask-info', ticket })
  .then((reply) => {
    const info = reply as { pattern?: string; site?: string } | undefined;
    if (!info?.pattern) {
      button.textContent = 'Expired';
      return;
    }
    pattern = info.pattern;
    button.title = `Let Aloud read pages from ${info.site}`;
    button.disabled = false;
  })
  .catch(() => {
    button.textContent = 'Expired';
  });

button.addEventListener('click', () => {
  if (!pattern) return;
  button.disabled = true;
  // From the click itself, before anything is awaited: the browser asks only for a gesture.
  browser.permissions
    .request({ origins: [pattern] })
    .then(async (granted) => {
      if (!granted) {
        button.disabled = false;
        return;
      }
      button.textContent = 'Starting…';
      const reply = (await browser.runtime.sendMessage({ type: 'frame-ask-go', ticket })) as { ok?: boolean } | undefined;
      if (!reply?.ok) {
        button.textContent = 'Try again';
        button.disabled = false;
      }
    })
    .catch(() => {
      button.textContent = 'Try again';
      button.disabled = false;
    });
});
