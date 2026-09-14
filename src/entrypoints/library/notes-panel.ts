/**
 * The Notes section: every kept passage, grouped by document, searchable, editable, exportable.
 */
import { el } from '@/shared/dom';
import { sourceUrl } from '@/shared/doc-source';
import {
  groupBySource,
  loadNotes,
  notesToMarkdown,
  removeNote,
  restoreNote,
  searchNotes,
  updateNote,
  watchNotes,
  type Note,
} from '@/shared/notes';
import { $, ago, toast } from './feedback';

let notes: Note[] = [];
let query = '';
/** A comment being typed is not redrawn under the cursor when storage echoes the change back. */
let editing: string | null = null;

export async function initNotes(opts: { onCount: (n: number) => void; onListen: (note: Note) => void }): Promise<void> {
  const render = (): void => {
    opts.onCount(notes.length);
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
    query = search.value;
    render();
  });
  $('copyNotes').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(notesToMarkdown(searchNotes(notes, query)));
      toast(query ? 'Copied the matching notes' : 'Copied all your notes');
    } catch {
      toast('Could not reach the clipboard', 'error');
    }
  });
  $('downloadNotes').addEventListener('click', () => {
    const blob = new Blob([notesToMarkdown(searchNotes(notes, query))], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = el(document, 'a', { href: url, download: `Aloud notes ${new Date().toISOString().slice(0, 10)}.md` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
}

function renderNotes(onListen: (note: Note) => void): void {
  const shown = searchNotes(notes, query);
  $('notesEmpty').hidden = notes.length > 0;
  $('copyNotes').toggleAttribute('disabled', shown.length === 0);
  $('downloadNotes').toggleAttribute('disabled', shown.length === 0);

  const list = $('notesList');
  if (notes.length > 0 && shown.length === 0) {
    list.replaceChildren(el(document, 'p', { class: 'muted no-match' }, `No notes match “${query}”.`));
    return;
  }
  list.replaceChildren(
    ...groupBySource(shown).map(({ source, notes: group }) => {
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
  card.append(el(document, 'blockquote', {}, note.text));

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

  const foot = el(document, 'footer', { class: 'note-foot' });
  foot.append(el(document, 'span', { class: 'muted small' }, ago(note.createdAt)));
  const actions = el(document, 'div', { class: 'note-actions' });
  if (note.at) {
    const listen = el(document, 'button', { type: 'button', class: 'btn-sm', title: 'Open the document and pick up at this sentence' }, '▶ Listen from here');
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
