/**
 * Tags as chips: type a tag, press Enter (or a comma) and it becomes a chip with its own ✕.
 * Backspace in the empty field takes the last chip back out. Used by the note editor on pages
 * (inside a shadow root) and by the Library, so both behave the same.
 *
 * Styles live with each host (`TAG_INPUT_CSS`), since a shadow root sees none of the page's.
 */
import { parseTags } from '@/shared/notes';

export interface TagInputOptions {
  tags: readonly string[];
  /** Called with the whole list whenever a chip is added or removed. */
  onChange(tags: string[]): void;
  /** Existing tags to offer while typing. */
  suggestions?: readonly string[];
  /** A chip's label was clicked (the Library filters by it). */
  onPick?(tag: string): void;
  placeholder?: string;
}

let lists = 0;

export function tagInput(doc: Document, opts: TagInputOptions): HTMLElement {
  let tags = [...opts.tags];
  const box = doc.createElement('div');
  box.className = 'tag-input';
  const field = doc.createElement('input');
  field.type = 'text';
  field.className = 'tag-field';
  field.placeholder = opts.placeholder ?? 'Add a tag';
  field.setAttribute('aria-label', 'Add a tag, then press Enter');
  field.autocomplete = 'off';
  field.enterKeyHint = 'done';

  if (opts.suggestions?.length) {
    const list = doc.createElement('datalist');
    list.id = `aloud-tags-${++lists}`;
    for (const t of opts.suggestions) {
      const option = doc.createElement('option');
      option.value = t;
      list.append(option);
    }
    field.setAttribute('list', list.id);
    box.append(list);
  }

  const render = (): void => {
    for (const chip of [...box.querySelectorAll('.tag-chip')]) chip.remove();
    for (const tag of tags) box.insertBefore(chip(tag), field);
    field.placeholder = tags.length ? '' : (opts.placeholder ?? 'Add a tag');
  };

  const chip = (tag: string): HTMLElement => {
    const c = doc.createElement('span');
    c.className = 'tag-chip';
    const label = doc.createElement(opts.onPick ? 'button' : 'span');
    label.className = 'tag-label';
    label.textContent = `#${tag}`;
    if (opts.onPick) {
      (label as HTMLButtonElement).type = 'button';
      label.title = `Show notes tagged ${tag}`;
      label.addEventListener('click', () => opts.onPick?.(tag));
    }
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'tag-x';
    x.textContent = '✕';
    x.setAttribute('aria-label', `Remove tag ${tag}`);
    x.addEventListener('click', () => {
      tags = tags.filter((t) => t !== tag);
      render();
      opts.onChange([...tags]);
      field.focus();
    });
    c.append(label, x);
    return c;
  };

  const commit = (): boolean => {
    const fresh = parseTags(field.value).filter((t) => !tags.includes(t));
    field.value = '';
    if (!fresh.length) return false;
    tags = [...tags, ...fresh];
    render();
    opts.onChange([...tags]);
    return true;
  };

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (!field.value.trim()) return;
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !field.value && tags.length) {
      e.preventDefault();
      tags = tags.slice(0, -1);
      render();
      opts.onChange([...tags]);
    }
  });
  // A comma typed on a phone keyboard (no keydown key) or pasted text: chips as soon as it is there.
  field.addEventListener('input', () => {
    if (field.value.includes(',')) commit();
  });
  field.addEventListener('blur', () => void commit());
  box.addEventListener('click', (e) => {
    if (e.target === box) field.focus();
  });

  box.append(field);
  render();
  return box;
}

/** Shared look; each host adds it to its own stylesheet. Uses the host's `--c-*` tokens if any. */
export const TAG_INPUT_CSS = `
.tag-input { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 34px; padding: 4px 6px;
  border: 1px solid var(--tag-border, rgba(127,127,127,.35)); border-radius: 10px; background: var(--tag-bg, transparent); cursor: text; box-sizing: border-box; }
.tag-input:focus-within { border-color: var(--tag-focus, rgba(127,127,127,.7)); }
.tag-chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 9px; border-radius: 999px;
  background: var(--tag-chip, rgba(127,127,127,.18)); font-size: 12.5px; line-height: 20px; }
.tag-chip .tag-label { all: unset; cursor: default; }
.tag-chip button.tag-label { cursor: pointer; }
.tag-chip button.tag-label:hover { text-decoration: underline; }
.tag-x { all: unset; display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%;
  font-size: 10px; cursor: pointer; opacity: .7; }
.tag-x:hover, .tag-x:focus-visible { opacity: 1; background: rgba(127,127,127,.3); }
.tag-input input.tag-field { all: unset; flex: 1 1 90px; min-width: 90px; font: inherit; font-size: 13px; padding: 3px 4px; color: inherit; }
.tag-input input.tag-field::placeholder { opacity: .65; }
`;
