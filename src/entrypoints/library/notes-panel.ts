/**
 * The Notes section: every kept passage and highlight, grouped by page, filterable by site and
 * tag, searchable, editable, exportable — and each one openable at its place on the page.
 */
import { browser } from 'wxt/browser';
import { el } from '@/shared/dom';
import { sourceUrl } from '@/shared/doc-source';
import { textFragmentUrl } from '@/annotate/anchor';
import { MARK_COLORS } from '@/pdf/annotations/model';
import {
  filterNotes,
  groupBySource,
  loadNotes,
  noteFacets,
  notesToJson,
  notesToMarkdown,
  parseTags,
  removeNote,
  restoreNote,
  updateNote,
  watchNotes,
  type Note,
} from '@/shared/notes';
import { $, ago, toast } from './feedback';

let notes: Note[] = [];
const filter = { query: '', site: '', tag: '' };
/** A comment being typed is not redrawn under the cursor when storage echoes the change back. */
let editing: string | null = null;

export async function initNotes(opts: { onCount: (n: number) => void; onListen: (note: Note) => void }): Promise<void> {
  const render = (): void => {
    opts.onCount(notes.length);
    renderFilters();
    renderNotes(opts.onListen);
  };
  notes = await loadNotes();
  render();
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
  $<HTMLSelectElement>('noteTag').addEventListener('change', (e) => {
    filter.tag = (e.target as HTMLSelectElement).value;
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
  $('downloadJson').addEventListener('click', () => download(notesToJson(shown()), 'json', 'application/json'));
}

const shown = (): Note[] => filterNotes(notes, filter);
const isFiltered = (): boolean => !!(filter.query || filter.site || filter.tag);

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
  fillSelect($<HTMLSelectElement>('noteTag'), 'All tags', tags.map(([t, n]) => [`#${t}`, n, t]), filter.tag);
  $('noteTag').hidden = tags.length === 0;
  $('noteSite').hidden = sites.length < 2 && !filter.site;
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
      ? `${list.length} of ${notes.length} notes — exports include only these`
      : `${notes.length} note${notes.length === 1 ? '' : 's'}`
    : '';

  const host = $('notesList');
  if (notes.length > 0 && list.length === 0) {
    host.replaceChildren(el(document, 'p', { class: 'muted no-match' }, 'No notes match.'));
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
}

function noteCard(note: Note, onListen: (note: Note) => void): HTMLElement {
  const card = el(document, 'article', { class: 'note' });
  const color = MARK_COLORS.find((c) => c.id === (note.color ?? 'yellow'))?.fill ?? MARK_COLORS[0]!.fill;
  const quote = el(document, 'blockquote', {}, note.text);
  quote.style.borderLeftColor = color;
  card.append(quote);

  const comment = el(document, 'textarea', { rows: '1', placeholder: 'Add your thoughts…', 'aria-label': 'Your note' });
  comment.value = note.comment;
  const fit = (): void => {
    comment.style.height = 'auto';
    comment.style.height = `${comment.scrollHeight}px`;
  };
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
  });
  requestAnimationFrame(fit);
  card.append(comment);

  const tags = el(document, 'input', { class: 'note-tags', placeholder: 'Add tags, separated by commas', 'aria-label': 'Tags' }) as HTMLInputElement;
  tags.value = (note.tags ?? []).join(', ');
  tags.addEventListener('focus', () => (editing = note.id));
  let tagTimer = 0;
  const saveTags = (): void => {
    clearTimeout(tagTimer);
    const next = parseTags(tags.value);
    if (next.join(',') !== (note.tags ?? []).join(',')) void updateNote(note.id, { tags: next });
  };
  tags.addEventListener('input', () => {
    clearTimeout(tagTimer);
    tagTimer = window.setTimeout(saveTags, 600);
  });
  tags.addEventListener('change', saveTags);
  tags.addEventListener('blur', () => {
    saveTags();
    editing = null;
  });
  card.append(tags);

  const foot = el(document, 'footer', { class: 'note-foot' });
  foot.append(el(document, 'span', { class: 'muted small' }, ago(note.createdAt)));
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
