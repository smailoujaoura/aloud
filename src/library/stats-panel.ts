/**
 * "Statistics": words and time heard, documents finished, by day, site and language.
 *
 * Every figure comes from `shared/listening-stats.ts`, which counts only audio that played. The
 * totals, the chart and both breakdowns are sums over the same days, so they agree: the sites add
 * up to the total, and so do the languages, with what could not be told shown as unknown rather
 * than left out. History's per-document totals are older than these and are shown apart, as what
 * they are.
 */
import { el } from '@/shared/dom';
import { languageName } from '@/shared/language-voice';
import { formatListeningTime, loadHistory, watchHistory, type History } from '@/shared/reading-history';
import { clearStats, dayKey, loadStats, summarize, watchStats, type ListeningStats, type StatsSummary } from '@/shared/listening-stats';
import { $, toast } from './feedback';

const DAY_MS = 24 * 3600_000;

export async function initStats(): Promise<void> {
  let stats = await loadStats();
  let history: History = await loadHistory();
  const range = $<HTMLSelectElement>('statsRange');
  const from = $<HTMLInputElement>('statsFrom');
  const to = $<HTMLInputElement>('statsTo');

  const render = (): void => {
    const [start, end] = rangeOf(range.value, stats, from.value, to.value);
    $('statsCustom').hidden = range.value !== 'custom';
    if (range.value !== 'custom') {
      from.value = start;
      to.value = end;
    }
    renderSummary(summarize(stats, start, end), stats, history);
  };
  range.addEventListener('change', render);
  from.addEventListener('change', render);
  to.addEventListener('change', render);
  watchStats((next) => {
    stats = next;
    render();
  });
  watchHistory((next) => {
    history = next;
    render();
  });
  $('clearStats').addEventListener('click', async () => {
    if (!confirm('Clear every listening statistic? History, notes and the queue are kept. Counting starts again from now.')) return;
    await clearStats();
    toast('Statistics cleared. Counting from now');
  });
  render();
}

/** The first and last day of a range choice, as `YYYY-MM-DD`. */
export function rangeOf(choice: string, stats: ListeningStats, from: string, to: string, now = Date.now()): [string, string] {
  const today = dayKey(now);
  if (choice === 'custom' && from && to) return from <= to ? [from, to] : [to, from];
  if (choice === 'all') {
    const first = Object.keys(stats.days).sort()[0];
    const since = dayKey(stats.since);
    return [first && first < since ? first : since, today];
  }
  const days = Number(choice) || 30;
  return [dayKey(now - (days - 1) * DAY_MS), today];
}

function renderSummary(summary: StatsSummary, stats: ListeningStats, history: History): void {
  const minutes = summary.seconds / 60;
  const tiles: Array<[string, string]> = [
    ['Words heard', Math.round(summary.words).toLocaleString()],
    ['Listening time', summary.seconds > 0 ? formatListeningTime(summary.seconds) : '0 min'],
    ['Documents finished', summary.completed.toLocaleString()],
    ['Average pace', summary.seconds >= 30 ? `${Math.round(summary.words / minutes)} wpm` : '—'],
  ];
  $('statsTotals').replaceChildren(
    ...tiles.map(([label, value]) => {
      const tile = el(document, 'div');
      tile.append(el(document, 'dt', {}, label), el(document, 'dd', {}, value));
      return tile;
    }),
  );

  // One bar a day; at a year's width the bars are thin, but every day is still there.
  const max = Math.max(...summary.daily.map((d) => d.seconds), 0);
  $('statsChart').replaceChildren(
    ...summary.daily.map((d) => {
      const bar = el(document, 'span', { class: d.seconds > 0 ? '' : 'none' });
      bar.style.height = max > 0 ? `${Math.max(1, (d.seconds / max) * 100)}%` : '1px';
      bar.title = `${longDay(d.day)}: ${d.seconds > 0 ? `${formatListeningTime(d.seconds)}, ${Math.round(d.words).toLocaleString()} words` : 'nothing'}`;
      return bar;
    }),
  );
  const first = summary.daily[0]?.day;
  const last = summary.daily.at(-1)?.day;
  $('statsChartCaption').replaceChildren(
    el(document, 'span', {}, first ? shortDay(first) : ''),
    el(document, 'span', {}, max > 0 ? `Busiest day: ${formatListeningTime(max)}` : 'Nothing heard in these days'),
    el(document, 'span', {}, last ? shortDay(last) : ''),
  );

  renderBreakdown('statsSites', summary.sites, summary.seconds, (key) => key || 'No site (local files)');
  renderBreakdown('statsLanguages', summary.languages, summary.seconds, (key) => (key ? languageName(key) : 'Unknown language'));

  const legacy = Object.values(history).reduce((sum, e) => sum + e.listenedSeconds, 0);
  $('statsSince').textContent =
    `Counting since ${new Date(stats.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.` +
    (legacy > 0
      ? ` History also counts ${formatListeningTime(legacy)} from before then, not split by day.`
      : '');
}

function renderBreakdown(id: string, rows: StatsSummary['sites'], total: number, label: (key: string) => string): void {
  const list = $(id);
  if (rows.length === 0) {
    const empty = el(document, 'li', { class: 'unknown' });
    empty.append(el(document, 'span', {}, 'Nothing yet'));
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...rows.map((row) => {
      const li = el(document, 'li', { class: row.key ? '' : 'unknown' });
      const share = total > 0 ? row.seconds / total : 0;
      const bar = el(document, 'i');
      bar.style.width = `${Math.max(1, share * 100)}%`;
      li.append(
        el(document, 'span', {}, label(row.key)),
        el(document, 'span', {}, `${formatListeningTime(row.seconds)} · ${Math.round(row.words).toLocaleString()} words`),
        bar,
      );
      return li;
    }),
  );
}

function dateOf(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 12);
}

function longDay(day: string): string {
  return dateOf(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function shortDay(day: string): string {
  return dateOf(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function documents(n: number): string {
  return `${n.toLocaleString()} document${n === 1 ? '' : 's'}`;
}
