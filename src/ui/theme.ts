/**
 * The one place that decides whether Aloud is light or dark right now.
 *
 * Every surface Aloud draws — the in-page control bar, the options page, the PDF reader and the
 * walkthrough — reads its colours from CSS custom properties that are defined twice: once for
 * light and once for dark. Which set applies is decided by a `data-theme` attribute, which this
 * module stamps.
 *
 * The stylesheets still carry a `prefers-color-scheme` fallback for the moment before this
 * module runs (an extension page paints before its module executes, and an inline script to
 * beat that is forbidden by our CSP). Once stamped, the attribute wins in both directions, so an
 * explicit "light" survives a dark OS and vice versa.
 */
import type { ThemeChoice } from '@/shared/settings';

export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What `theme` means on this machine, right now. */
export function resolveTheme(theme: ThemeChoice, view: Window | null = globalThis.window): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  try {
    return view?.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    // matchMedia can be missing in a stripped-down context; light is the safer guess.
    return 'light';
  }
}

/**
 * Apply `theme` to a whole document (options page, PDF reader, walkthrough).
 *
 * `color-scheme` is set alongside the attribute so the browser's own widgets — scrollbars,
 * `<select>` popups, form controls, the canvas behind the page — match the theme Aloud picked
 * rather than the one the OS picked.
 */
export function applyTheme(doc: Document, theme: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(theme, doc.defaultView);
  const root = doc.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = theme === 'system' ? 'light dark' : resolved;
  return resolved;
}

/**
 * Watch the OS preference and call `cb` when it flips.
 *
 * Registered unconditionally rather than only for `system`: the listener is free, and it means a
 * page that later switches back to `system` is already following along. Returns an unsubscribe.
 */
export function watchSystemTheme(cb: (system: ResolvedTheme) => void, view: Window | null = globalThis.window): () => void {
  let media: MediaQueryList;
  try {
    media = view!.matchMedia(DARK_QUERY);
  } catch {
    return () => undefined;
  }
  const onChange = (e: MediaQueryListEvent): void => cb(e.matches ? 'dark' : 'light');
  // `addEventListener` on a MediaQueryList is Safari 14+ / everything we support; the older
  // `addListener` is kept only because it costs one line and never throws.
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }
  media.addListener(onChange);
  return () => media.removeListener(onChange);
}

/** The next theme in the light → dark → system cycle, for a one-button toggle. */
export function nextTheme(theme: ThemeChoice): ThemeChoice {
  return theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
