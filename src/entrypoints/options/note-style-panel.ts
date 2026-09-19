/**
 * Settings for how kept passages look on web pages: the colours (each one's name and shade can
 * be changed), which colour a plain highlight and a written note get, and whether new ones are
 * highlighted or underlined. Changing a colour here recolours every note that uses it.
 */
import { inkFor, parseHex } from '@/annotate/palette';
import { el } from '@/shared/dom';
import { DEFAULT_NOTE_COLORS, type AnnotateSettings, type NoteColor, type NoteStyle } from '@/shared/settings';

export interface NoteStylePanelOptions {
  settings: AnnotateSettings;
  save(patch: Partial<AnnotateSettings>): Promise<void>;
}

export function renderNoteStylePanel(host: HTMLElement, opts: NoteStylePanelOptions): void {
  const s = opts.settings;
  const colors = s.colors.length ? s.colors : DEFAULT_NOTE_COLORS;

  const style = select(
    [
      { value: 'highlight', label: 'Highlight' },
      { value: 'underline', label: 'Underline' },
    ],
    s.defaultStyle,
    (value) => void opts.save({ defaultStyle: value as NoteStyle }),
  );
  const colorChoices = colors.map((c) => ({ value: c.id, label: c.label }));
  const plain = select(colorChoices, s.defaultColor, (value) => void opts.save({ defaultColor: value }));
  const noted = select(colorChoices, s.noteColor, (value) => void opts.save({ noteColor: value }));

  const palette = el(document, 'div', { class: 'note-palette' });
  colors.forEach((color, i) => palette.append(colorRow(color, (next) => {
    const list = colors.map((c, j) => (j === i ? next : c));
    void opts.save({ colors: list });
  })));

  const reset = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Reset colours');
  reset.addEventListener('click', () => void opts.save({ colors: DEFAULT_NOTE_COLORS.map((c) => ({ ...c })) }));

  host.replaceChildren(
    row('Mark new passages with', style),
    row('Plain highlights', plain),
    row('Passages with a note', noted),
    el(document, 'p', { class: 'row-hint' }, '“Add note” uses the second colour, so what you wrote about stands out from what you only marked.'),
    el(document, 'p', { class: 'sub-label' }, 'Colours'),
    palette,
    reset,
  );
}

function colorRow(color: NoteColor, onChange: (next: NoteColor) => void): HTMLElement {
  const wrap = el(document, 'div', { class: 'palette-row' });
  const lit = el(document, 'span', { class: 'palette-sample' }, 'highlighted');
  const under = el(document, 'span', { class: 'palette-sample is-underline' }, 'underlined');
  const preview = el(document, 'span', { class: 'palette-preview' });
  preview.append(lit, under);
  const paint = (fill: string): void => {
    lit.style.backgroundColor = `${fill}99`;
    under.style.textDecorationColor = inkFor(fill);
  };
  paint(color.fill);
  const picker = el(document, 'input', { type: 'color', 'aria-label': `${color.label} colour` }) as HTMLInputElement;
  picker.value = parseHex(color.fill) ? color.fill : '#ffd83a';
  picker.addEventListener('input', () => paint(picker.value));
  picker.addEventListener('change', () => onChange({ ...color, fill: picker.value }));
  const name = el(document, 'input', { type: 'text', class: 'palette-name', 'aria-label': 'Colour name', maxlength: '24' }) as HTMLInputElement;
  name.value = color.label;
  const commit = (): void => {
    const label = name.value.trim() || color.label;
    name.value = label;
    if (label !== color.label) onChange({ ...color, label });
  };
  name.addEventListener('change', commit);
  wrap.append(picker, name, preview);
  return wrap;
}

function row(label: string, control: HTMLElement): HTMLElement {
  const r = el(document, 'label', { class: 'row' });
  r.append(el(document, 'span', {}, label), control);
  return r;
}

function select(options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => void): HTMLSelectElement {
  const picker = el(document, 'select', {}) as HTMLSelectElement;
  for (const option of options) {
    const node = el(document, 'option', { value: option.value }, option.label);
    if (option.value === current) node.selected = true;
    picker.append(node);
  }
  picker.addEventListener('change', () => onChange(picker.value));
  return picker;
}
