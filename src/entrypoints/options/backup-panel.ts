/**
 * The Backup & restore view: one file with everything (shared/backup.ts), and restoring from one
 * — choosing what to bring in, then fetching the voices it had, setting the keyboard shortcuts
 * back, and asking again for the sites that were allowed, since a browser grants those to an
 * install, not to a file.
 */
import { browser } from 'wxt/browser';
import {
  BACKUP_PARTS,
  backupFileName,
  describeBackup,
  makeBackup,
  parseBackup,
  overflowOf,
  restorePlan,
  type Backup,
  type BackupModels,
  type BackupPart,
} from '@/shared/backup';
import { el } from '@/shared/dom';
import { withStorageLocks } from '@/shared/storage-lock';
import { piperDownloaded, readCacheSizes, sharedModelInstalled } from '@/engine/installed-voices';
import type { ModelManifest } from '@/engine/engines/types';
import { getSettings, type Settings } from '@/shared/settings';
import { engineConfigFor } from './engine-config';
import { RowProgress, downloadPiperVoice, downloadSharedModel } from './downloads';
import { downloads, type ProgressSink } from './download-queue';

export interface BackupPanelOptions {
  manifest: ModelManifest;
  toast(message: string, kind?: 'info' | 'ok' | 'error'): void;
  /** Settings were replaced: redraw the page from storage. */
  onRestored(): Promise<void>;
}

/** Every stored value a restore may rewrite, by the lock its own writers take. */
const RESTORE_LOCKS = ['settings', 'notes', 'queue', 'history', 'positions', 'site-speeds', 'stats'];

const PART_LABEL: Record<BackupPart, string> = {
  settings: 'Settings and voices',
  notes: 'Notes',
  library: 'Queue, history and reading positions',
  speeds: 'Video speeds per site',
  pdfMarks: 'PDF marks',
  shortcuts: 'Keyboard shortcuts',
};

export function renderBackupPanel(host: HTMLElement, opts: BackupPanelOptions): void {
  const exportBtn = el(document, 'button', { type: 'button', class: 'primary' }, 'Download a backup');
  const exportNote = el(document, 'p', { class: 'muted small' }, 'Settings, voices, keys, notes, the queue, history, reading positions, video speeds and PDF marks. Voice models download again on restore.');
  exportBtn.addEventListener('click', () => void exportBackup(opts).catch((err) => opts.toast(`Could not make the backup: ${String(err)}`, 'error')));
  // Your setup without your reading: to set up another browser the way you like it, or to keep a
  // known-good default — no notes, queue, history or statistics in the file.
  const settingsBtn = el(document, 'button', { type: 'button' }, 'Download settings only');
  settingsBtn.title = 'Settings, voices and shortcuts. No notes, history, queue or statistics';
  settingsBtn.addEventListener('click', () => void exportBackup(opts, true).catch((err) => opts.toast(`Could not save the settings: ${String(err)}`, 'error')));

  const file = el(document, 'input', { type: 'file', accept: '.json,application/json', hidden: '' }) as HTMLInputElement;
  const importBtn = el(document, 'button', { type: 'button' }, 'Restore from a file…');
  importBtn.addEventListener('click', () => file.click());
  const result = el(document, 'div', { class: 'backup-result' });
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    try {
      showRestore(result, parseBackup(await chosen.text()), opts);
    } catch (err) {
      result.replaceChildren(el(document, 'p', { class: 'warn-text' }, err instanceof Error ? err.message : String(err)));
    }
  });

  const exportRow = el(document, 'div', { class: 'backup-row' });
  exportRow.append(exportBtn, settingsBtn, importBtn, file);
  host.replaceChildren(exportRow, exportNote, result);
}

async function exportBackup(opts: BackupPanelOptions, settingsOnly = false): Promise<void> {
  const stored = (await browser.storage.local.get(null)) as Record<string, unknown>;
  const all = settingsOnly ? { settings: stored.settings } : stored;
  const backup = makeBackup(all, {
    aloud: browser.runtime.getManifest().version,
    models: await installedModels(opts.manifest),
    shortcuts: await currentShortcuts(),
  });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el(document, 'a', { href: url, download: settingsOnly ? backupFileName().replace('aloud-backup', 'aloud-settings') : backupFileName() });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const d = describeBackup(backup);
  opts.toast(settingsOnly ? `Settings saved: ${d.settings.toLowerCase()}, and keyboard shortcuts` : `Backup saved: ${d.notes}, ${d.settings.toLowerCase()}`, 'ok');
}

async function installedModels(manifest: ModelManifest): Promise<BackupModels> {
  const sizes = await readCacheSizes();
  return {
    piper: Object.entries(manifest.piper)
      .filter(([, entry]) => piperDownloaded(entry, sizes))
      .map(([id]) => id),
    kokoro: sharedModelInstalled('kokoro', sizes),
    supertonic: sharedModelInstalled('supertonic', sizes),
  };
}

async function currentShortcuts(): Promise<Record<string, string>> {
  try {
    const commands = (await browser.commands?.getAll?.()) ?? [];
    return Object.fromEntries(commands.filter((c) => c.name).map((c) => [c.name!, c.shortcut ?? '']));
  } catch {
    return {};
  }
}

function showRestore(host: HTMLElement, backup: Backup, opts: BackupPanelOptions): void {
  const described = describeBackup(backup);
  const when = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString() : 'an unknown date';
  const head = el(document, 'p', {}, `Backup from ${when}${backup.aloud ? ` (Aloud ${backup.aloud})` : ''}. Restore:`);
  const boxes = new Map<BackupPart, HTMLInputElement>();
  const list = el(document, 'div', { class: 'backup-parts' });
  for (const part of BACKUP_PARTS) {
    const row = el(document, 'label', { class: 'row check' });
    const box = el(document, 'input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = true;
    boxes.set(part, box);
    const text = el(document, 'span', {}, `${PART_LABEL[part]} `);
    text.append(el(document, 'span', { class: 'muted' }, `· ${described[part]}`));
    row.append(box, text);
    list.append(row);
  }
  const note = el(document, 'p', { class: 'muted small' }, 'Settings are replaced by the backup’s. Everything else is merged: nothing you kept since is lost.');
  const go = el(document, 'button', { type: 'button', class: 'primary' }, 'Restore');
  const after = el(document, 'div', { class: 'backup-after' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const parts = new Set(BACKUP_PARTS.filter((p) => boxes.get(p)!.checked));
    try {
      // Read, merge and write under the same locks every other writer takes: a note kept in a
      // reading tab between the read and the write would otherwise be overwritten by the merge.
      // PDF marks included: each document's key is the lock its open editors write under
      // (pdf/annotations/sync.ts). Without it, an autosave in flight overwrote the restored marks.
      const pdfLocks = parts.has('pdfMarks') ? Object.keys(backup.pdfMarks) : [];
      const all = await withStorageLocks([...RESTORE_LOCKS, ...pdfLocks], async () => {
        const current = (await browser.storage.local.get(null)) as Record<string, unknown>;
        const plan = restorePlan(backup, current, parts);
        if (Object.keys(plan).length) await browser.storage.local.set(plan);
        return current;
      });
      await opts.onRestored();
      // What would not fit is said out loud: a restore that quietly drops records is the kind of
      // thing people find out about months later.
      const over = overflowOf(backup, all);
      const missed = [
        parts.has('notes') && over.notes ? `${over.notes} note${over.notes === 1 ? '' : 's'}` : '',
        parts.has('library') && over.queue ? `${over.queue} queued article${over.queue === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      opts.toast(missed.length ? `Restored, except ${missed.join(' and ')}, which did not fit` : 'Restored', missed.length ? 'info' : 'ok');
      await followUps(after, backup, parts, opts);
    } catch (err) {
      opts.toast(`Could not restore: ${String(err)}`, 'error');
      go.disabled = false;
    }
  });
  host.replaceChildren(head, list, note, go, after);
}

/** What a file cannot do by itself: voices to download, shortcuts to set, sites to allow. */
async function followUps(host: HTMLElement, backup: Backup, parts: ReadonlySet<BackupPart>, opts: BackupPanelOptions): Promise<void> {
  host.replaceChildren();
  const settings = await getSettings();

  if (parts.has('settings')) {
    const sizes = await readCacheSizes();
    const piper = backup.models.piper.filter((id) => opts.manifest.piper[id] && !piperDownloaded(opts.manifest.piper[id]!, sizes));
    const shared = (['supertonic', 'kokoro'] as const).filter((e) => backup.models[e] && !sharedModelInstalled(e, sizes));
    const count = piper.length + shared.length;
    if (count) host.append(downloadStep(piper, shared, settings, opts));
  }

  if (parts.has('shortcuts')) {
    const wanted = Object.entries(backup.shortcuts);
    const now = await currentShortcuts();
    const differ = wanted.filter(([name, key]) => name in now && now[name] !== key);
    if (differ.length) host.append(await shortcutStep(differ));
  }

  if (parts.has('settings')) {
    const sites = [...new Set([...settings.mediaSpeed.alwaysOn, ...settings.annotate.alwaysOn])];
    const missing: string[] = [];
    for (const site of sites) {
      const origins = site === '*' ? ['*://*/*'] : [`*://${site}/*`];
      if (!(await browser.permissions.contains({ origins }).catch(() => false))) missing.push(site);
    }
    if (missing.length) host.append(siteStep(missing, opts));
  }

  if (!host.childElementCount) host.append(el(document, 'p', { class: 'muted small' }, 'Everything is back.'));
}

function step(title: string, text: string, action: HTMLElement): HTMLElement {
  const box = el(document, 'div', { class: 'backup-step' });
  const words = el(document, 'div', {});
  words.append(el(document, 'b', {}, title), el(document, 'p', { class: 'muted small' }, text));
  box.append(words, action);
  return box;
}

function downloadStep(piper: string[], shared: Array<'kokoro' | 'supertonic'>, settings: Settings, opts: BackupPanelOptions): HTMLElement {
  const names = [
    ...piper.map((id) => opts.manifest.piper[id]?.label ?? id),
    ...shared.map((e) => (e === 'kokoro' ? 'Kokoro' : 'Supertonic')),
  ];
  const btn = el(document, 'button', { type: 'button', class: 'primary btn-sm' }, `Download ${names.length} voice model${names.length === 1 ? '' : 's'}`);
  const progress = new RowProgress();
  const box = step('Voices', `The backup had ${names.join(', ')} downloaded.`, btn);
  box.append(progress.wrap, progress.msg);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    // Into the same line as the Download buttons, one after another — and this step says where
    // the line is while it waits, instead of standing still.
    type Job = [key: string, label: string, run: (p: ProgressSink, signal: AbortSignal) => Promise<void>];
    const jobs: Job[] = [
      ...piper.map((id): Job => [
        `piper:${id}`,
        opts.manifest.piper[id]?.label ?? id,
        (p, signal) => downloadPiperVoice(opts.manifest.piper[id]!, p, signal),
      ]),
      ...shared.map((engine): Job => [
        `model:${engine}`,
        `${engine === 'kokoro' ? 'Kokoro-82M' : 'Supertonic 3'} model`,
        (p, signal) =>
          downloadSharedModel(
            engineConfigFor(settings, { engine, purpose: 'download' }),
            Object.keys(engine === 'kokoro' ? opts.manifest.kokoro.voices : (opts.manifest.supertonic?.voices ?? {})),
            p,
            signal,
          ),
      ]),
    ];
    const show = (): void => {
      const mine = downloads.all().filter((v) => jobs.some(([key]) => key === v.key));
      const now = mine[0];
      if (!now) return;
      const left = mine.length;
      if (now.phase === 'waiting') progress.note(`${now.text} · ${left} of ${jobs.length} to go`);
      else progress.show(`${now.text.replace(/ \d+%$/, '')} · ${left} of ${jobs.length} to go`, now.ratio);
    };
    const stop = downloads.subscribe(show);
    try {
      progress.start('Starting…');
      await Promise.all(jobs.map(([key, label, run]) => downloads.enqueue(key, label, run)));
      stop();
      progress.done();
      btn.textContent = 'Downloaded';
      await opts.onRestored();
    } catch (err) {
      stop();
      progress.fail(err instanceof Error ? err.message : String(err));
      btn.disabled = false;
    }
  });
  return box;
}

async function shortcutStep(differ: Array<[string, string]>): Promise<HTMLElement> {
  const text = differ.map(([name, key]) => `${name}: ${key || 'none'}`).join(' · ');
  // Firefox lets an add-on set its own shortcuts (`commands.update`); Chromium has no such call.
  const update = (browser.commands as unknown as { update?: (d: { name: string; shortcut: string }) => Promise<void> } | undefined)?.update;
  if (typeof update === 'function') {
    const results = await Promise.all(
      differ.map(([name, shortcut]) => update({ name, shortcut }).then(() => true, () => false)),
    );
    const failed = differ.filter((_, i) => !results[i]).map(([name]) => name);
    const done = el(document, 'span', { class: 'muted small' }, failed.length ? `Could not set: ${failed.join(', ')}` : 'Set');
    return step('Keyboard shortcuts', text, done);
  }
  const open = el(document, 'button', { type: 'button', class: 'btn-sm' }, 'Open the shortcuts page');
  open.addEventListener('click', () => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => undefined));
  return step('Keyboard shortcuts', `This browser only lets you set them yourself: ${text}`, open);
}

function siteStep(sites: string[], opts: BackupPanelOptions): HTMLElement {
  const btn = el(document, 'button', { type: 'button', class: 'primary btn-sm' }, `Allow on ${sites.length} site${sites.length === 1 ? '' : 's'}`);
  btn.addEventListener('click', async () => {
    const origins = sites.flatMap((s) => (s === '*' ? ['*://*/*'] : [`*://${s}/*`, `*://*.${s}/*`]));
    // Asked from this click; the browser shows what is being allowed.
    const granted = await browser.permissions.request({ origins }).catch(() => false);
    if (!granted) return;
    btn.textContent = 'Allowed';
    btn.disabled = true;
    // The background registers the sites when the settings change; nudge it.
    const s = await getSettings();
    await browser.storage.local.set({ settings: { ...s } });
    opts.toast('Sites allowed', 'ok');
  });
  return step('Sites', `Speed control and highlights started by themselves on ${sites.join(', ')}. The browser needs your permission for them again.`, btn);
}
