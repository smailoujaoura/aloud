/**
 * The Notes section: every kept passage and highlight, grouped by page, filterable by site and
 * tag, searchable, editable, exportable — and each one openable at its place on the page.
 */
import { browser } from 'wxt/browser';
import { el } from '@/shared/dom';
import { sourceUrl } from '@/shared/doc-source';
import { textFragmentUrl } from '@/annotate/anchor';
import { colorFor, inkFor } from '@/annotate/palette';
import { DEFAULT_NOTE_COLORS, getSettings, watchSettings, type NoteColor } from '@/shared/settings';
import { TAG_INPUT_CSS, tagInput } from '@/ui/tag-input';
import {
  filterNotes,
  groupBySource,
  loadNotes,
  noteFacets,
  mergeInNotes,
  MAX_NOTES,
  notesToFile,
  parseNotesFile,
  notesToMarkdown,
  removeNote,
  sinceFor,
  sortNotes,
  restoreNote,
  updateNote,
  watchNotes,
  type Note,
  type NoteWhen,
} from '@/shared/notes';
import { $, ago, toast } from './feedback';

let notes: Note[] = [];
/** The reader's colours (settings: annotate.colors), so a note's stripe matches its mark. */
let palette: NoteColor[] = DEFAULT_NOTE_COLORS;
const filter = { query: '', site: '', tag: '', when: 'any' as NoteWhen, color: '', commented: false };
let order: 'page' | 'newest' | 'oldest' = 'page';
/** A comment being typed is not redrawn under the cursor when storage echoes the change back. */
let editing: string | null = null;

let rerender: () => void = () => undefined;

export async function initNotes(opts: { onCount: (n: number) => void; onListen: (note: Note) => void }): Promise<void> {
  const render = (): void => {
    opts.onCount(notes.length);
    renderFilters();
    renderNotes(opts.onListen);
  };
  rerender = render;
  document.head.append(el(document, 'style', {}, TAG_INPUT_CSS));
  notes = await loadNotes();
  palette = (await getSettings()).annotate.colors;
  render();
  watchSettings((s) => {
    if (JSON.stringify(s.annotate.colors) === JSON.stringify(palette)) return;
    palette = s.annotate.colors;
    render();
  });
  watchNotes((next) => {
    notes = next;
    if (!editing) render();
    else opts.onCount(notes.length);
  });

  const search = $<HTMLInputElement>('noteSearch');
  search.addEventListener('input', () => {
    filter.query = search.value;
    render();
  });
  $<HTMLSelectElement>('noteSite').addEventListener('change', (e) => {
    filter.site = (e.target as HTMLSelectElement).value;
    render();
  });
  $<HTMLSelectElement>('noteWhen').addEventListener('change', (e) => {
    filter.when = (e.target as HTMLSelectElement).value as NoteWhen;
    render();
  });
  $<HTMLSelectElement>('noteOrder').addEventListener('change', (e) => {
    order = (e.target as HTMLSelectElement).value as typeof order;
    render();
  });

  $('copyNotes').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(notesToMarkdown(shown()));
      toast(isFiltered() ? 'Copied the notes shown' : 'Copied all your notes');
    } catch {
      toast('Could not reach the clipboard', 'error');
    }
  });
  $('downloadNotes').addEventListener('click', () => download(notesToMarkdown(shown()), 'md', 'text/markdown'));
  $('downloadJson').addEventListener('click', () => download(notesToFile(shown()), 'json', 'application/json'));

  // Importing is the other half of exporting: a notes file (or a whole backup) from another
  // browser or computer, merged into what is here — the same note is never doubled.
  const file = $<HTMLInputElement>('importNotes');
  $('importNotesButton').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    try {
      const { added, updated, skipped } = await mergeInNotes(parseNotesFile(await chosen.text()));
      const plural = (n: number): string => `${n} note${n === 1 ? '' : 's'}`;
      // A note that did not fit is said out loud, and is never made room for by deleting one.
      const full = skipped ? ` · ${plural(skipped)} left out: you have the maximum ${MAX_NOTES.toLocaleString()} notes` : '';
      toast(
        added || updated
          ? `${plural(added)} added${updated ? `, ${updated} updated` : ''}${full}`
          : skipped
            ? `Nothing added${full}`
            : 'Those notes were already here',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  });
}

const shown = (): Note[] => filterNotes(notes, { ...filter, since: sinceFor(filter.when) });
const isFiltered = (): boolean => !!(filter.query || filter.site || filter.tag || filter.when !== 'any' || filter.color || filter.commented);

/** The notes view is shown: size the note fields, which measure nothing while the view is hidden. */
export function refitNotes(): void {
  for (const t of document.querySelectorAll<HTMLTextAreaElement>('#notesList textarea')) fitField(t);
}

function fitField(t: HTMLTextAreaElement): void {
  if (!t.isConnected || t.offsetParent === null) return; // hidden: keep the CSS height
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
}

/** The file name says what is in it: "Aloud notes · doc.rust-lang.org · rust-book · 2026-09-18.md". */
function download(text: string, ext: string, type: string): void {
  const parts = ['Aloud notes', filter.site, filter.tag, new Date().toISOString().slice(0, 10)].filter(Boolean);
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el(document, 'a', { href: url, download: `${parts.join(' · ')}.${ext}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function renderFilters(): void {
  const { sites, tags } = noteFacets(notes);
  fillSelect($<HTMLSelectElement>('noteSite'), 'All sites', sites, filter.site);
  $('noteSite').hidden = sites.length < 2 && !filter.site;

  // One row of toggles: your tags, the colours in use, and "with writing". Pressing one again
  // (or another of its kind) changes the filter; nothing to open first.
  const chips: HTMLElement[] = [];
  const chip = (label: string, pressed: boolean, title: string, onPress: () => void, swatch?: string): HTMLElement => {
    const b = el(document, 'button', { type: 'button', class: 'filter-chip', 'aria-pressed': String(pressed), title }, label);
    if (swatch) {
      b.classList.add('is-color');
      b.style.setProperty('--c', swatch);
    }
    b.addEventListener('click', () => {
      onPress();
      rerender();
    });
    return b;
  };
  for (const [tag, n] of tags) chips.push(chip(`#${tag} ${n}`, filter.tag === tag, `Only notes tagged ${tag}`, () => (filter.tag = filter.tag === tag ? '' : tag)));
  const used = new Set(notes.map((n) => n.color ?? ''));
  const colours = palette.filter((c) => used.has(c.id));
  if (colours.length > 1) {
    for (const c of colours) chips.push(chip('', filter.color === c.id, `Only ${c.label.toLocaleLowerCase()} marks`, () => (filter.color = filter.color === c.id ? '' : c.id), c.fill));
  }
  if (notes.some((n) => n.comment.trim())) chips.push(chip('✎ With writing', filter.commented, 'Only notes you wrote something under', () => (filter.commented = !filter.commented)));
  if (isFiltered()) {
    const clear = el(document, 'button', { type: 'button', class: 'filter-chip clear' }, 'Clear filters');
    clear.addEventListener('click', () => {
      Object.assign(filter, { query: '', site: '', tag: '', when: 'any', color: '', commented: false });
      $<HTMLInputElement>('noteSearch').value = '';
      $<HTMLSelectElement>('noteWhen').value = 'any';
      rerender();
    });
    chips.push(clear);
  }
  $('noteChips').replaceChildren(...chips);
  $('noteChips').hidden = chips.length === 0;
}

function fillSelect(select: HTMLSelectElement, all: string, items: Array<[string, number] | [string, number, string]>, current: string): void {
  select.replaceChildren(el(document, 'option', { value: '' }, all));
  for (const [label, count, value = label] of items as Array<[string, number, string?]>) {
    const option = el(document, 'option', { value: value ?? label }, `${label} (${count})`);
    if ((value ?? label) === current) option.selected = true;
    select.append(option);
  }
}

function renderNotes(onListen: (note: Note) => void): void {
  const list = shown();
  $('notesEmpty').hidden = notes.length > 0;
  for (const id of ['copyNotes', 'downloadNotes', 'downloadJson']) $(id).toggleAttribute('disabled', list.length === 0);
  $('notesShown').textContent = notes.length
    ? isFiltered()
      ? `${list.length} of ${notes.length} notes`
      : `${notes.length} note${notes.length === 1 ? '' : 's'}`
    : '';

  const host = $('notesList');
  if (notes.length > 0 && list.length === 0) {
    host.replaceChildren(el(document, 'p', { class: 'muted no-match' }, 'No notes match.'));
    return;
  }
  if (order !== 'page') {
    host.replaceChildren(...sortNotes(list, order).map((note) => noteCard(note, onListen, true)));
    refitNotes();
    return;
  }
  host.replaceChildren(
    ...groupBySource(list).map(({ source, notes: group }) => {
      const section = el(document, 'section', { class: 'note-group' });
      const url = sourceUrl(source);
      const head = el(document, 'header', { class: 'note-source' });
      const title = url
        ? el(document, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, source.title || source.site)
        : el(document, 'span', {}, source.title || source.site);
      head.append(title, el(document, 'span', { class: 'muted small' }, [source.site, `${group.length} note${group.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')));
      section.append(head);
      for (const note of group) section.append(noteCard(note, onListen));
      return section;
    }),
  );
  refitNotes();
}

/** Changes made while a field had focus were not drawn; draw them once focus has left the notes. */
function afterEditing(): void {
  window.setTimeout(() => {
    if (!editing) rerender();
  }, 50);
}

function noteCard(note: Note, onListen: (note: Note) => void, withSource = false): HTMLElement {
  const card = el(document, 'article', { class: 'note' });
  if (withSource) {
    // Newest or oldest first, notes from many pages sit together: each says where it is from.
    const url = sourceUrl(note.source);
    const label = note.source.title || note.source.site;
    card.append(
      url
        ? el(document, 'a', { class: 'note-from', href: url, target: '_blank', rel: 'noopener noreferrer', title: note.source.site }, label)
        : el(document, 'span', { class: 'note-from' }, label),
    );
  }
  const fill = colorFor(palette, note.color).fill;
  const color = note.style === 'underline' ? inkFor(fill) : fill;
  const quote = el(document, 'blockquote', {}, note.text);
  quote.style.borderLeftColor = color;
  card.append(quote);

  const comment = el(document, 'textarea', { rows: '2', placeholder: 'Write a note…', 'aria-label': 'Your note' });
  comment.value = note.comment;
  const fit = (): void => fitField(comment);
  let timer = 0;
  comment.addEventListener('focus', () => (editing = note.id));
  comment.addEventListener('input', () => {
    fit();
    clearTimeout(timer);
    timer = window.setTimeout(() => void updateNote(note.id, { comment: comment.value }), 400);
  });
  comment.addEventListener('blur', () => {
    clearTimeout(timer);
    editing = null;
    if (comment.value !== note.comment) void updateNote(note.id, { comment: comment.value });
    afterEditing();
  });
  card.append(comment);

  const tags = tagInput(document, {
    tags: note.tags ?? [],
    placeholder: 'Add a tag',
    suggestions: noteFacets(notes).tags.map(([t]) => t),
    onChange: (next) => void updateNote(note.id, { tags: next }),
    onPick: (tag) => {
      filter.tag = tag;
      rerender();
    },
  });
  tags.classList.add('note-tags');
  tags.addEventListener('focusin', () => (editing = note.id));
  tags.addEventListener('focusout', () => {
    editing = null;
    afterEditing();
  });
  card.append(tags);

  const foot = el(document, 'footer', { class: 'note-foot' });
  foot.append(el(document, 'span', { class: 'muted small', title: new Date(note.createdAt).toLocaleString() }, ago(note.createdAt)));
  const actions = el(document, 'div', { class: 'note-actions' });
  const url = sourceUrl(note.source);
  if (note.anchor && url && note.source.reopen.kind === 'web') {
    const open = el(document, 'button', { type: 'button', class: 'btn-sm', title: 'Open the page, scrolled to this highlight' }, '↗ Open at highlight');
    open.addEventListener('click', () => openAtHighlight(note, url));
    actions.append(open);
  }
  if (note.at) {
    const listen = el(document, 'button', { type: 'button', class: 'ghost btn-sm', title: 'Open the document and listen from this sentence' }, '▶ Listen from here');
    listen.addEventListener('click', () => onListen(note));
    actions.append(listen);
  }
  const copy = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Copy');
  copy.addEventListener('click', () => {
    const text = note.comment.trim() ? `${note.text}\n\n${note.comment.trim()}` : note.text;
    void navigator.clipboard.writeText(text).then(
      () => toast('Copied'),
      () => toast('Could not reach the clipboard', 'error'),
    );
  });
  const remove = el(document, 'button', { type: 'button', class: 'ghost btn-sm danger' }, 'Delete');
  remove.addEventListener('click', async () => {
    await removeNote(note.id);
    toast('Note deleted', 'info', { label: 'Undo', run: () => void restoreNote(note) });
  });
  actions.append(copy, remove);
  foot.append(actions);
  card.append(foot);
  return card;
}

/**
 * Open the page scrolled to the highlight. Asking for the site's permission here, inside the
 * click, lets Aloud draw every highlight on it; declined, the browser's own text-fragment link
 * still takes you to the passage.
 */
function openAtHighlight(note: Note, url: string): void {
  let origin: string | null = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    /* not a web address */
  }
  const fragmentUrl = note.anchor ? textFragmentUrl(url, note.anchor) : url;
  const granted = origin ? browser.permissions.request({ origins: [origin] }).catch(() => false) : Promise.resolve(false);
  void granted.then((canInject) =>
    browser.runtime.sendMessage({ type: 'open-note', id: note.id, url, fragmentUrl, canInject }).catch(() => undefined),
  );
}
