import { describe, it, expect } from 'vitest';
import { settingsReplace } from '@/shared/settings-tabs';

describe('where the toolbar button opens settings on a page it cannot read', () => {
  it('over an empty page, or one of the browser’s own', () => {
    for (const url of ['about:newtab', 'about:blank', 'about:preferences', 'about:debugging#/runtime/this-firefox', 'about:addons', 'chrome://extensions/', 'chrome://newtab/', 'edge://settings']) {
      expect(settingsReplace(url), url).toBe(true);
    }
  });

  it('beside anyone’s page: a store, a local file, an address it cannot see', () => {
    for (const url of ['https://addons.mozilla.org/en-US/firefox/', 'https://chromewebstore.google.com/', 'file:///home/me/notes.html', undefined, '']) {
      expect(settingsReplace(url), String(url)).toBe(false);
    }
  });
});
