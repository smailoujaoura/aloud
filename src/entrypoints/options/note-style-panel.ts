/**
 * Settings for how kept passages look on web pages: highlighted or underlined, and the colour a
 * plain highlight and a written note each get — picked from swatches, the way they look on a page.
 *
 * The palette's names and shades are no longer edited here: a colour list with rename fields and
 * a colour picker per entry read as a second, different control for the same choice.
 */
import { inkFor } from '@/annotate/palette';
import { el } from '@/shared/dom';
import { DEFAULT_NOTE_COLORS, type AnnotateSettings, type NoteColor, type NoteStyle } from '@/shared/settings';

export interface NoteStylePanelOptions {
  settings: AnnotateSettings;
  save(patch: Partial<AnnotateSettings>): Promise<void>;
}

export function renderNoteStylePanel(host: HTMLElement, opts: NoteStylePanelOptions): void {
  const s = opts.settings;
  const colors = s.colors.length ? s.colors : DEFAULT_NOTE_COLORS;
  const plainFill = (colors.find((c) => c.id === s.defaultColor) ?? colors[0]!).fill;

  const style = segmented(
    [
      { value: 'highlight', label: 'Highlight', sample: (n) => (n.style.backgroundColor = `${plainFill}99`) },
      { value: 'underline', label: 'Underline', sample: (n) => (n.style.textDecoration = `underline 3px ${inkFor(plainFill)}`) },
    ],
    s.defaultStyle,
    (value) => void opts.save({ defaultStyle: value as NoteStyle }),
  );

  host.replaceChildren(
    row('Mark new passages with', style),
    row('Plain highlights', swatches(colors, s.defaultColor, 'Plain highlights', (id) => void opts.save({ defaultColor: id }))),
    row('Passages with a note', swatches(colors, s.noteColor, 'Passages with a note', (id) => void opts.save({ noteColor: id })), 'So what you wrote about stands out from what you only marked.'),
  );
}

/** A colour choice as the colours themselves: one press picks, the picked one is ringed. */
function swatches(colors: readonly NoteColor[], current: string, label: string, onPick: (id: string) => void): HTMLElement {
  const group = el(document, 'div', { class: 'swatches', role: 'radiogroup', 'aria-label': label });
  for (const color of colors) {
    const b = el(document, 'button', { type: 'button', class: 'swatch-pick', role: 'radio', title: color.label, 'aria-label': color.label, 'aria-checked': String(color.id === current) });
    b.style.setProperty('--c', color.fill);
    b.addEventListener('click', () => {
      for (const other of group.children) other.setAttribute('aria-checked', String(other === b));
      onPick(color.id);
    });
    group.append(b);
  }
  return group;
}

/** Two or three choices side by side, each showing what it does. */
function segmented(
  options: Array<{ value: string; label: string; sample?: (node: HTMLElement) => void }>,
  current: string,
  onChange: (value: string) => void,
): HTMLElement {
  const group = el(document, 'div', { class: 'theme-switch style-switch', role: 'radiogroup' });
  for (const option of options) {
    const b = el(document, 'button', { type: 'button', class: 'seg', role: 'radio', 'aria-checked': String(option.value === current), 'aria-pressed': String(option.value === current) });
    const text = el(document, 'span', { class: 'seg-sample' }, option.label);
    option.sample?.(text);
    b.append(text);
    b.addEventListener('click', () => {
      for (const other of group.children) {
        other.setAttribute('aria-pressed', String(other === b));
        other.setAttribute('aria-checked', String(other === b));
      }
      onChange(option.value);
    });
    group.append(b);
  }
  return group;
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const r = el(document, 'div', { class: 'row' });
  const text = el(document, 'span', { class: 'row-label' });
  text.append(el(document, 'span', {}, label));
  if (hint) text.append(el(document, 'span', { class: 'muted' }, hint));
  r.append(text, control);
  return r;
}
