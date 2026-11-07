/**
 * The "Read it" button on a page whose article is in a frame from another site (a Claude
 * artifact). Pressing it asks the browser for that site, then the background starts the reader in
 * the frame. A page of Aloud's own, because the browser shows its permission prompt only for a
 * click in one of the extension's pages.
 *
 * Firefox gives an Aloud page inside a website no `permissions` API at all ("permissions is
 * undefined": the button greyed and nothing followed). There the button opens this page in a tab
 * of its own (`?tab`), where it can ask; once allowed, the tab closes and the reading starts in
 * the tab the reader came from.
 *
 * It acts only on a one-time ticket the background issued for that tab (entrypoints/background.ts:
 * readInFrame), so a site that embeds this page cannot make it ask for anything.
 */
import { browser } from 'wxt/browser';

const ticket = location.hash.slice(1);
const inTab = new URLSearchParams(location.search).has('tab');
const button = document.getElementById('go') as HTMLButtonElement;
const why = document.getElementById('why') as HTMLElement;
let pattern: string | null = null;

if (inTab) {
  document.body.classList.add('in-tab');
  button.textContent = 'Allow';
}

void browser.runtime
  .sendMessage({ type: 'frame-ask-info', ticket })
  .then((reply) => {
    const info = reply as { pattern?: string; site?: string } | undefined;
    if (!info?.pattern) {
      button.textContent = 'Expired';
      if (inTab) why.textContent = 'This request has expired. Press Aloud’s button on the page again.';
      return;
    }
    pattern = info.pattern;
    button.title = `Let Aloud read pages from ${info.site}`;
    if (inTab) why.textContent = `The article on that page is in an embedded page from ${info.site}. Allow Aloud to read pages from ${info.site}, and it starts reading there.`;
    button.disabled = false;
  })
  .catch(() => {
    button.textContent = 'Expired';
  });

button.addEventListener('click', () => {
  if (!pattern) return;
  button.disabled = true;
  const permissions = (browser as { permissions?: typeof browser.permissions }).permissions;
  if (!permissions?.request) {
    // Firefox, inside the website: ask from a tab of Aloud's own instead.
    button.textContent = 'Opening…';
    void browser.runtime.sendMessage({ type: 'frame-ask-open', ticket }).catch(() => {
      button.textContent = 'Try again';
      button.disabled = false;
    });
    return;
  }
  // From the click itself, before anything is awaited: the browser asks only for a gesture.
  permissions
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
