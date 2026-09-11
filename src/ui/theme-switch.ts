/**
 * The light / dark / system segmented control, shared by the settings page and the walkthrough.
 *
 * One component rather than two, because a theme picker that looks or behaves differently on the
 * two pages that offer it is a small lie about how the setting works: it is one setting, applied
 * to everything Aloud draws.
 */
import { el, svgIcon } from '@/shared/dom';
import type { ThemeChoice } from '@/shared/settings';
import { ICON_PATHS } from './icons';
import { THEME_LABEL } from './theme';

const ORDER: ThemeChoice[] = ['light', 'dark', 'system'];

const ICONS: Record<ThemeChoice, readonly string[]> = {
  light: ICON_PATHS.sun,
  dark: ICON_PATHS.moon,
  system: ICON_PATHS.monitor,
};

export interface ThemeSwitch {
  /** The control itself, ready to be appended. */
  root: HTMLElement;
  /** Move the selection without firing `onChange` — for when the setting changed elsewhere. */
  setTheme(theme: ThemeChoice): void;
}

export function createThemeSwitch(
  doc: Document,
  current: ThemeChoice,
  onChange: (theme: ThemeChoice) => void,
): ThemeSwitch {
  const root = el(doc, 'div', { class: 'theme-switch', role: 'group', 'aria-label': 'Theme' });

  const buttons = ORDER.map((choice) => {
    const btn = el(doc, 'button', {
      class: 'seg',
      type: 'button',
      'data-theme-choice': choice,
      title: `Theme: ${THEME_LABEL[choice].toLowerCase()}`,
      'aria-pressed': String(choice === current),
    });
    btn.append(svgIcon(doc, [...ICONS[choice]], 14), el(doc, 'span', {}, THEME_LABEL[choice]));
    btn.addEventListener('click', () => {
      setTheme(choice);
      onChange(choice);
    });
    return btn;
  });
  root.append(...buttons);

  function setTheme(theme: ThemeChoice): void {
    for (const btn of buttons) btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === theme));
  }

  return { root, setTheme };
}
