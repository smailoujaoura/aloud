/**
 * Aloud's one page: a navigation of views — the Library's (Continue, Up next, Notes, History) and
 * the settings' (Voice, Reading, …) — one shown at a time.
 *
 * Every view has an address (`options.html#notes`), so the reading bar, the menus and the notes
 * panel can open the right one, and the browser's back button goes back to the view before.
 */

export const VIEWS = [
  'continue',
  'queue',
  'notes',
  'pdfs',
  'history',
  'stats',
  'voice',
  'reading',
  'appearance',
  'highlights',
  'speed',
  'pronunciation',
  'shortcuts',
  'backup',
  'advanced',
] as const;
export type View = (typeof VIEWS)[number];

const DEFAULT_VIEW: View = 'voice';

let current: View | null = null;
const listeners: Array<(view: View) => void> = [];

export function viewFromHash(hash = location.hash): View | null {
  const name = hash.slice(1) as View;
  return VIEWS.includes(name) ? name : null;
}

export function showView(view: View, opts: { focus?: boolean; push?: boolean } = {}): void {
  for (const node of document.querySelectorAll<HTMLElement>('.view[data-view]')) node.hidden = node.dataset.view !== view;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.nav-item[data-view]')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (location.hash !== `#${view}`) {
    if (opts.push) history.pushState(null, '', `#${view}`);
    else history.replaceState(null, '', `#${view}`);
  }
  if (current !== view) window.scrollTo({ top: 0 });
  current = view;
  revealInNav(view);
  if (opts.focus) document.querySelector<HTMLElement>(`#view-${view} h1, #view-${view} h2`)?.focus?.();
  for (const fn of listeners) fn(view);
}

/**
 * On a narrow window the navigation is one row that scrolls sideways: keep the current view's
 * item on screen there, so a reload on "Advanced" does not land back at the left end.
 */
function revealInNav(view: View): void {
  const row = document.querySelector<HTMLElement>('.app-nav');
  const link = document.querySelector<HTMLElement>(`.nav-item[data-view="${view}"]`);
  if (!row || !link || row.scrollWidth <= row.clientWidth) return;
  const target = link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2;
  row.scrollLeft = Math.max(0, Math.min(target, row.scrollWidth - row.clientWidth));
}

export function currentView(): View | null {
  return current;
}

export function onViewChange(fn: (view: View) => void): void {
  listeners.push(fn);
}

/** The count badge next to a Library view in the navigation; nothing shown for zero. */
export function setNavCount(view: View, n: number): void {
  const badge = document.getElementById(`count-${view}`);
  if (badge) badge.textContent = n ? String(n) : '';
}

/** Wire the navigation and show the view the address asks for (or `fallback`). */
export function initNav(fallback: View = DEFAULT_VIEW): void {
  // Every link that names a view, in the navigation or inside a view's own text.
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-view]')) {
    link.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      showView(link.dataset.view as View, { push: true });
    });
  }
  window.addEventListener('hashchange', () => {
    const view = viewFromHash();
    if (view) showView(view);
  });
  window.addEventListener('popstate', () => {
    const view = viewFromHash();
    if (view) showView(view);
  });
  showView(viewFromHash() ?? fallback);
}
