/**
 * The Library: what to continue, what is up next, the notes kept along the way, and history.
 *
 * Everything here lives in `storage.local` on this device (see `shared/notes.ts`,
 * `shared/reading-history.ts`, `shared/reading-queue.ts`) and updates live as the reader writes
 * to it from other tabs.
 */
import type { LibraryTab } from '@/shared/messages';
import { getSettings, watchSettings } from '@/shared/settings';
import { applyTheme, watchSystemTheme } from '@/ui/theme';
import { $ } from './feedback';
import { initNotes } from './notes-panel';
import { initQueue } from './queue-panel';
import { initReading } from './reading-panels';
import { reopen } from './reopen';

const TABS: LibraryTab[] = ['continue', 'queue', 'notes', 'history'];

function show(tab: LibraryTab, focus = false): void {
  for (const name of TABS) {
    const button = $(`tab-${name}`);
    const selected = name === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`panel-${name}`).hidden = !selected;
    if (selected && focus) button.focus();
  }
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
}

function tabFromHash(): LibraryTab | null {
  const name = location.hash.slice(1) as LibraryTab;
  return TABS.includes(name) ? name : null;
}

function setCount(tab: LibraryTab, n: number): void {
  $(`count-${tab}`).textContent = n ? String(n) : '';
}

async function init(): Promise<void> {
  const settings = await getSettings();
  applyTheme(document, settings.theme);
  watchSystemTheme(() => void getSettings().then((s) => applyTheme(document, s.theme)));
  watchSettings((s) => applyTheme(document, s.theme));

  for (const name of TABS) $(`tab-${name}`).addEventListener('click', () => show(name));
  // Arrow keys move between tabs, as in any tab list.
  document.querySelector('.lib-tabs')!.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key !== 'ArrowRight' && key !== 'ArrowLeft') return;
    const current = TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
    const next = TABS[(current + (key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
    show(next, true);
  });
  window.addEventListener('hashchange', () => {
    const tab = tabFromHash();
    if (tab) show(tab);
  });

  const showQueue = (): void => show('queue');
  let continueCount = 0;
  await Promise.all([
    initQueue({ onCount: (n) => setCount('queue', n) }),
    initNotes({
      onCount: (n) => setCount('notes', n),
      onListen: (note) => void reopen(note.source, note.at, showQueue),
    }),
    initReading({
      onContinueCount: (n) => {
        continueCount = n;
        setCount('continue', n);
      },
      onContinue: (entry) => void reopen(entry.source, null, showQueue),
    }),
  ]);

  // Open where asked; otherwise where there is something to do.
  show(tabFromHash() ?? (continueCount > 0 ? 'continue' : 'queue'));
}

void init();
