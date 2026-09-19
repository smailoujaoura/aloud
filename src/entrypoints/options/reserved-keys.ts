/**
 * Shortcuts the browser has already taken.
 *
 * A browser shortcut that the browser itself uses never reaches an extension: the press opens a
 * menu or a tab instead, and it looks as though Aloud is broken. (That is exactly what happened
 * with `Alt+S`, which opens Firefox's History menu, and with `Alt+Shift+<letter>`, the chord
 * Firefox gives web pages for their own access keys.) So the Shortcuts view checks what you press
 * against this list and says what already owns it.
 *
 * Not exhaustive and cannot be: a browser's list changes with platform and version, and nothing in
 * the extension APIs reports it. It covers what people actually press.
 */

export type BrowserKind = 'gecko' | 'blink';

const FIREFOX: Record<string, string> = {
  'Alt+F': 'opens Firefox’s File menu',
  'Alt+E': 'opens Firefox’s Edit menu',
  'Alt+V': 'opens Firefox’s View menu',
  'Alt+S': 'opens Firefox’s History menu',
  'Alt+B': 'opens Firefox’s Bookmarks menu',
  'Alt+T': 'opens Firefox’s Tools menu',
  'Alt+H': 'opens Firefox’s Help menu',
  'Alt+D': 'jumps to the address bar',
  'Alt+Left': 'goes back',
  'Alt+Right': 'goes forward',
  'Alt+Home': 'opens your home page',
  'Ctrl+K': 'jumps to the search bar',
  'Ctrl+B': 'opens the bookmarks sidebar',
  'Ctrl+I': 'opens page information',
  'Ctrl+U': 'shows the page source',
  'Ctrl+Shift+A': 'opens Add-ons',
  'Ctrl+Shift+E': 'opens the Network tool',
  'Ctrl+Shift+K': 'opens the Web Console',
  'Ctrl+Shift+M': 'opens Responsive Design Mode',
  'Ctrl+Shift+N': 'reopens the last closed window',
  'Ctrl+Shift+O': 'opens the bookmarks library',
  'Ctrl+Shift+P': 'opens a private window',
  'Ctrl+Shift+Y': 'opens Downloads',
  'F7': 'turns caret browsing on or off',
};

const CHROMIUM: Record<string, string> = {
  'Alt+E': 'opens the browser menu',
  'Alt+F': 'opens the browser menu',
  'Alt+D': 'jumps to the address bar',
  'Alt+Left': 'goes back',
  'Alt+Right': 'goes forward',
  'Alt+Home': 'opens your home page',
  'Ctrl+Shift+A': 'opens tab search',
  'Ctrl+Shift+B': 'shows or hides the bookmarks bar',
  'Ctrl+Shift+D': 'bookmarks every open tab',
  'Ctrl+Shift+M': 'switches profile',
  'Ctrl+Shift+N': 'opens an incognito window',
  'Ctrl+Shift+O': 'opens the bookmark manager',
};

/** Taken in every browser. */
const COMMON: Record<string, string> = {
  'Ctrl+T': 'opens a new tab',
  'Ctrl+W': 'closes the tab',
  'Ctrl+N': 'opens a new window',
  'Ctrl+P': 'prints',
  'Ctrl+S': 'saves the page',
  'Ctrl+O': 'opens a file',
  'Ctrl+F': 'finds in the page',
  'Ctrl+L': 'jumps to the address bar',
  'Ctrl+D': 'bookmarks the page',
  'Ctrl+J': 'opens Downloads',
  'Ctrl+H': 'opens History',
  'Ctrl+R': 'reloads',
  'Ctrl+Q': 'quits the browser',
  'Ctrl+Shift+C': 'opens the element inspector',
  'Ctrl+Shift+I': 'opens the developer tools',
  'Ctrl+Shift+J': 'opens the console',
  'Ctrl+Shift+R': 'reloads, ignoring the cache',
  'Ctrl+Shift+T': 'reopens the last closed tab',
  'Ctrl+Shift+W': 'closes the window',
  'Ctrl+Shift+Delete': 'opens “clear browsing data”',
  'F3': 'finds again',
  'F5': 'reloads',
  'F6': 'moves focus to the toolbar',
  'F11': 'goes full screen',
  'F12': 'opens the developer tools',
};

/** What already uses `shortcut` in this browser, or null when it looks free. */
export function reservedUse(shortcut: string, browser: BrowserKind): string | null {
  if (!shortcut) return null;
  const key = shortcut.trim();
  const table = browser === 'gecko' ? FIREFOX : CHROMIUM;
  const found = table[key] ?? COMMON[key];
  if (found) return found;
  // Firefox fires a page's own access keys on Alt+Shift+<letter>, so a page can eat the press.
  if (browser === 'gecko' && /^Alt\+Shift\+[A-Z0-9]$/.test(key)) return 'is what web pages use for their own access keys on Firefox';
  return null;
}
