/**
 * "Continue" and "History": what has been listened to, how far, and what is left.
 */
import { el } from '@/shared/dom';
import { sourceUrl } from '@/shared/doc-source';
import {
  clearHistory,
  continueList,
  formatListeningTime,
  historyList,
  loadHistory,
  progressOf,
  remainingSeconds,
  removeFromHistory,
  watchHistory,
  type History,
  type HistoryEntry,
} from '@/shared/reading-history';
import { $, ago } from './feedback';

export async function initReading(opts: { onContinueCount: (n: number) => void; onContinue: (entry: HistoryEntry) => void }): Promise<void> {
  const render = (history: History): void => {
    const unfinished = continueList(history);
    opts.onContinueCount(unfinished.length);
    renderContinue(unfinished, opts.onContinue);
    renderHistory(history);
    renderPdfs(history, opts.onContinue);
  };
  render(await loadHistory());
  watchHistory(render);
  $('clearHistory').addEventListener('click', async () => {
    if (!confirm('Forget everything you have listened to? Notes and the queue are kept.')) return;
    await clearHistory();
  });
}

function renderContinue(entries: HistoryEntry[], onContinue: (entry: HistoryEntry) => void): void {
  $('continueEmpty').hidden = entries.length > 0;
  $('continueList').replaceChildren(
    ...entries.map((entry) => {
      const card = el(document, 'li', { class: 'card' });
      const text = el(document, 'div', { class: 'card-text' });
      text.append(titleOf(entry));
      text.append(
        el(document, 'span', { class: 'card-meta' }, [entry.source.site, `${formatListeningTime(remainingSeconds(entry))} left`, ago(entry.lastReadAt)].filter(Boolean).join(' · ')),
      );
      text.append(progressBar(entry));

      const actions = el(document, 'div', { class: 'card-actions' });
      const go = el(document, 'button', { type: 'button', class: 'primary btn-sm' }, '▶ Continue');
      go.addEventListener('click', () => onContinue(entry));
      const forget = el(document, 'button', { type: 'button', class: 'ghost btn-sm q-icon', title: 'Remove from this list', 'aria-label': 'Remove from this list' }, '✕');
      forget.addEventListener('click', () => void removeFromHistory(entry.source.key));
      actions.append(go, forget);
      card.append(text, actions);
      return card;
    }),
  );
}

function renderHistory(history: History): void {
  const entries = historyList(history);
  $('historyEmpty').hidden = entries.length > 0;
  $('clearHistory').hidden = entries.length === 0;
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const thisWeek = entries.filter((e) => e.lastReadAt >= weekAgo);
  const listened = entries.reduce((sum, e) => sum + e.listenedSeconds, 0);
  $('historySummary').textContent = entries.length
    ? `${formatListeningTime(listened)} listened across ${entries.length} document${entries.length === 1 ? '' : 's'} · ${thisWeek.length} this week`
    : '';
  $('historyList').replaceChildren(
    ...entries.map((entry) => {
      const card = el(document, 'li', { class: 'card' });
      const text = el(document, 'div', { class: 'card-text' });
      text.append(titleOf(entry));
      const state = entry.finished ? 'Finished' : `${Math.round(progressOf(entry) * 100)}%`;
      text.append(
        el(document, 'span', { class: 'card-meta' }, [entry.source.site, state, `${formatListeningTime(entry.listenedSeconds)} listened`, ago(entry.lastReadAt)].filter(Boolean).join(' · ')),
      );
      const forget = el(document, 'button', { type: 'button', class: 'ghost btn-sm q-icon', title: 'Remove from history', 'aria-label': 'Remove from history' }, '✕');
      forget.addEventListener('click', () => void removeFromHistory(entry.source.key));
      card.append(text, forget);
      return card;
    }),
  );
}

/** The PDFs view: every PDF listened to, newest first, each one click from where it stopped. */
function renderPdfs(history: History, onOpen: (entry: HistoryEntry) => void): void {
  const pdfs = historyList(history).filter((e) => e.source.reopen.kind === 'pdf' || e.source.reopen.kind === 'file');
  $('pdfEmpty').hidden = pdfs.length > 0;
  $('pdfList').replaceChildren(
    ...pdfs.map((entry) => {
      const card = el(document, 'li', { class: 'card' });
      const text = el(document, 'div', { class: 'card-text' });
      text.append(el(document, 'span', { class: 'card-title' }, entry.source.title || entry.source.site || 'Untitled'));
      const state = entry.finished ? 'Finished' : `${formatListeningTime(remainingSeconds(entry))} left`;
      text.append(el(document, 'span', { class: 'card-meta' }, [entry.source.site, state, ago(entry.lastReadAt)].filter(Boolean).join(' · ')));
      text.append(progressBar(entry));
      const actions = el(document, 'div', { class: 'card-actions' });
      const open = el(document, 'button', { type: 'button', class: 'btn-sm' }, entry.finished ? 'Open' : '▶ Continue');
      open.addEventListener('click', () => onOpen(entry));
      actions.append(open);
      card.append(text, actions);
      return card;
    }),
  );
}

function titleOf(entry: HistoryEntry): HTMLElement {
  const url = sourceUrl(entry.source);
  const label = entry.source.title || entry.source.site || 'Untitled';
  return url && entry.source.reopen.kind === 'web'
    ? el(document, 'a', { class: 'card-title', href: url, target: '_blank', rel: 'noopener noreferrer' }, label)
    : el(document, 'span', { class: 'card-title' }, label);
}

function progressBar(entry: HistoryEntry): HTMLElement {
  const pct = Math.round(progressOf(entry) * 100);
  const bar = el(document, 'span', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${pct}% listened` });
  const fill = el(document, 'i');
  fill.style.width = `${pct}%`;
  bar.append(fill);
  return bar;
}
