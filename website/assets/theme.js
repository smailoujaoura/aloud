/* Light or dark, as the visitor chooses (else as their system is), remembered on this device. Loaded
   in <head> so the page never flashes the other theme first. */
(() => {
  const KEY = 'aloud-site-theme';
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  const dark = () => root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  // Screenshots come in both themes; follow the page's, not only the system's.
  const pictures = () => {
    for (const s of document.querySelectorAll('picture source[media*="prefers-color-scheme: dark"], picture source[data-dark]')) {
      s.dataset.dark = '1';
      s.media = dark() ? 'all' : 'not all';
    }
  };
  addEventListener('DOMContentLoaded', () => {
    if (root.dataset.theme) pictures();
    const btn = document.getElementById('theme-btn');
    if (!btn) return;
    const label = () => btn.setAttribute('aria-label', dark() ? 'Switch to the light theme' : 'Switch to the dark theme');
    label();
    btn.addEventListener('click', () => {
      root.dataset.theme = dark() ? 'light' : 'dark';
      try { localStorage.setItem(KEY, root.dataset.theme); } catch { /* private window: this visit only */ }
      pictures();
      label();
    });
  });
})();
