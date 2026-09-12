/**
 * The "Voices & downloads" section: a tab per engine, and inside it only what is worth looking at.
 *
 * It used to be three stacked `<details>` panels, each holding an accordion per language — so
 * finding a voice meant scrolling past forty collapsed languages, and the thing you were looking
 * for scrolled away from the controls that acted on it. Now:
 *
 *  - one **tab** per engine, in a bar that stays put while the list under it scrolls;
 *  - Piper's 175 voices are reached by picking a **language**, not by opening accordions;
 *  - typing in the search box looks across every language of the active engine, because that is
 *    what someone typing a name means.
 *
 * The engines still differ in what a "download" is: Piper downloads per voice, while Kokoro and
 * Supertonic each download one model that unlocks all their voices.
 */
import { el } from '@/shared/dom';
import { humanBytes } from '@/shared/log';
import { engineInfo, listEngines, type EngineInfo } from '@/shared/engine-catalog';
import { isEnglish, listVoices, shortPiperLabel, type VoiceOption } from '@/shared/voice-catalog';
import { cacheClear, cacheDelete } from '@/engine/model-cache';
import { activeVoice, type EngineId, type Settings } from '@/shared/settings';
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';

import { RowProgress, downloadPiperVoice, downloadViaWorker } from './downloads';
import { previewFor } from './preview-button';
import { engineConfigFor } from './engine-config';
import {
  kokoroInstalledPrecision,
  piperDownloaded,
  piperVoiceBytes,
  sharedModelBytes,
  type CacheSizes,
} from '@/engine/installed-voices';

/** How the Kokoro precision options are named in the Advanced section. */
const PRECISION_LABEL: Record<'q8' | 'fp32', string> = {
  q8: 'quantised (~86 MB)',
  fp32: 'full precision (~320 MB)',
};

/** A search matching half the catalogue helps nobody; past this it asks for a narrower one. */
const MAX_SEARCH_RESULTS = 40;

export interface PanelContext {
  settings: Settings;
  manifest: ModelManifest;
  sizes: CacheSizes;
  /** Lowercased text from the search box, or '' for none. */
  filter: string;
  /** Re-read cache state and redraw the whole page. */
  refresh(): Promise<void>;
  /** Make (engine, voiceId) the active voice, then redraw. */
  useVoice(engine: EngineId, voiceId: string): Promise<void>;
  flashSaved(message?: string): void;
}

/**
 * Which engine's tab is open, and which language its list is showing.
 *
 * Deliberately *not* settings: browsing is not choosing. Opening the Kokoro tab to see what it
 * offers must not change the voice that reads the next page — only the radio does that.
 */
let openTab: EngineId | null = null;
let openLanguage: string | null = null;

/**
 * Downloads and deletions are serialised across the whole page: they all mutate the same cache
 * and every one of them ends in a full redraw, so letting two run at once produces rows that
 * disagree with the cache they are describing.
 */
let modelActionBusy = false;

async function runModelAction(button: HTMLButtonElement, action: () => Promise<void>): Promise<void> {
  if (modelActionBusy) return;
  modelActionBusy = true;
  button.disabled = true;
  try {
    await action();
  } finally {
    modelActionBusy = false;
  }
}

// ---- the section -----------------------------------------------------------

export function renderVoiceSection(
  tabsHost: HTMLElement,
  panelHost: HTMLElement,
  ctx: PanelContext,
): void {
  const engine = openTab ?? ctx.settings.engine;
  openTab = engine;

  tabsHost.replaceChildren(
    ...listEngines().map((info) => engineTab(info, engine, ctx, () => {
      openTab = info.id;
      openLanguage = null;
      renderVoiceSection(tabsHost, panelHost, ctx);
    })),
  );

  panelHost.replaceChildren(
    engine === 'piper' ? piperPanel(ctx, tabsHost, panelHost) : sharedPanel(engine, ctx),
  );
}

function engineTab(
  info: EngineInfo,
  active: EngineId,
  ctx: PanelContext,
  onPick: () => void,
): HTMLElement {
  const selected = info.id === active;
  const tab = el(document, 'button', {
    class: `voice-tab${selected ? ' is-active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': String(selected),
  });
  tab.append(
    el(document, 'b', {}, info.name),
    el(document, 'span', { class: 'voice-tab-status' }, installedSummary(info.id, ctx)),
  );
  // The engine currently reading gets a mark, so "which one am I using" survives browsing away.
  if (info.id === ctx.settings.engine) tab.append(el(document, 'span', { class: 'voice-tab-dot', title: 'Your current engine' }));
  tab.addEventListener('click', onPick);
  return tab;
}

function installedSummary(engine: EngineId, ctx: PanelContext): string {
  if (engine === 'piper') {
    const n = Object.values(ctx.manifest.piper).filter((v) => piperDownloaded(v, ctx.sizes)).length;
    return n ? `${n} voice${n > 1 ? 's' : ''}` : 'none yet';
  }
  const hint = engineInfo(engine).cacheHint;
  return hint && sharedModelBytes(ctx.sizes, hint) > 0 ? 'downloaded' : 'not downloaded';
}

/** The blurb and footprint that open every panel. */
function panelHeader(info: EngineInfo): HTMLElement {
  const head = el(document, 'div', { class: 'panel-head' });
  head.append(
    el(document, 'p', { class: 'panel-blurb muted small' }, info.blurb),
    el(document, 'p', { class: 'panel-size small' }, `Download: ${info.approxSize}`),
  );
  return head;
}

// ---- rows ------------------------------------------------------------------

/** A selectable voice: radio + name + preview, and whatever action the engine needs. */
function voiceRow(engine: EngineId, id: string, label: string, ctx: PanelContext, extra?: HTMLElement): HTMLElement {
  const row = el(document, 'div', { class: 'model-row voice-row' });

  const radio = el(document, 'input', { type: 'radio', name: 'voicePick', 'aria-label': `Use ${label}` });
  radio.checked = ctx.settings.engine === engine && activeVoice(ctx.settings) === id;
  radio.addEventListener('change', () => {
    if (radio.checked) void ctx.useVoice(engine, id);
  });

  row.append(
    radio,
    el(document, 'div', { class: 'model-name' }, label),
    el(document, 'span'),
    previewFor(engine, id, ctx),
    extra ?? el(document, 'span'),
  );
  return row;
}

function piperDownloadRow(id: string, entry: PiperVoiceEntry, ctx: PanelContext): HTMLElement {
  const row = el(document, 'div', { class: 'model-row voice-row' });
  const name = el(document, 'div', { class: 'model-name' });
  name.append(
    el(document, 'b', {}, shortPiperLabel(entry.label)),
    el(
      document,
      'small',
      {},
      `${entry.languageName ?? entry.language} · ${entry.quality} · ${entry.sizeBytes ? humanBytes(entry.sizeBytes) : '?'}`,
    ),
  );

  const progress = new RowProgress();
  const download = el(document, 'button', { class: 'model-btn' }, 'Download');
  download.addEventListener('click', () => {
    void runModelAction(download, async () => {
      try {
        progress.start(`Downloading ${shortPiperLabel(entry.label)}…`);
        await downloadPiperVoice(entry, progress);
        progress.done();
        ctx.flashSaved(`${shortPiperLabel(entry.label)} downloaded`);
        await ctx.refresh();
      } catch (err) {
        progress.fail(err instanceof Error ? err.message : String(err));
        download.disabled = false;
      }
    });
  });

  row.append(
    el(document, 'span'),
    name,
    el(document, 'span'),
    entry.sample ? previewFor('piper', id, ctx) : el(document, 'span'),
    download,
    progress.wrap,
    progress.msg,
  );
  return row;
}

// ---- Piper -----------------------------------------------------------------

function piperPanel(ctx: PanelContext, tabsHost: HTMLElement, panelHost: HTMLElement): HTMLElement {
  const panel = el(document, 'div', { class: 'panel-body' });
  panel.append(panelHeader(engineInfo('piper')));

  const entries = Object.entries(ctx.manifest.piper);
  const installed = entries.filter(([, v]) => piperDownloaded(v, ctx.sizes));
  const available = entries.filter(([, v]) => !piperDownloaded(v, ctx.sizes));

  // "Your voices" first, always: it is the short list, and the one people came back for.
  panel.append(el(document, 'p', { class: 'sub-head' }, installed.length ? 'Your voices' : 'No voices downloaded yet'));
  if (installed.length === 0) {
    panel.append(el(document, 'p', { class: 'muted small' }, 'Pick a language below and download one.'));
  }
  for (const [id, entry] of installed) {
    const del = el(document, 'button', { class: 'model-btn' }, 'Delete');
    del.addEventListener('click', () => {
      void runModelAction(del, async () => {
        await Promise.all([cacheDelete(entry.config), cacheDelete(entry.onnx)]);
        ctx.flashSaved(`${shortPiperLabel(entry.label)} deleted`);
        await ctx.refresh();
      });
    });
    const label = `${shortPiperLabel(entry.label)} · ${entry.languageName ?? entry.language} · ${entry.quality} · ${humanBytes(piperVoiceBytes(entry, ctx.sizes))}`;
    panel.append(voiceRow('piper', id, label, ctx, del));
  }

  panel.append(el(document, 'p', { class: 'sub-head' }, 'Add a voice'));

  // A search means "find this name wherever it is", so it overrides the language choice.
  if (ctx.filter) {
    const matches = available.filter(([key, v]) =>
      `${key} ${v.label} ${v.language} ${v.languageName ?? ''} ${v.quality}`.toLowerCase().includes(ctx.filter),
    );
    if (matches.length === 0) {
      panel.append(el(document, 'p', { class: 'muted small' }, 'No voices match that search.'));
      return panel;
    }
    for (const [id, entry] of matches.slice(0, MAX_SEARCH_RESULTS)) {
      panel.append(piperDownloadRow(id, entry, ctx));
    }
    if (matches.length > MAX_SEARCH_RESULTS) {
      panel.append(
        el(document, 'p', { class: 'muted small' },
          `${matches.length - MAX_SEARCH_RESULTS} more match — keep typing to narrow it down.`),
      );
    }
    return panel;
  }

  // Which language to show: the one being browsed, else the language of the current voice, else
  // whatever is first (English, by the ordering below).
  const languages = piperLanguages(available);
  const names = languages.map(([lang]) => lang);
  const preferred = ctx.manifest.piper[ctx.settings.piperVoice]?.languageName ?? '';
  const language =
    (openLanguage !== null && names.includes(openLanguage) ? openLanguage : null) ??
    (names.includes(preferred) ? preferred : (names[0] ?? ''));
  openLanguage = language;

  const picker = el(document, 'label', { class: 'row lang-row' });
  picker.append(el(document, 'span', {}, 'Language'));
  const select = el(document, 'select', { id: 'piperLanguage' });
  select.append(
    ...languages.map(([lang, count]) => {
      const option = el(document, 'option', { value: lang }, `${lang} (${count})`);
      if (lang === language) option.selected = true;
      return option;
    }),
  );
  select.addEventListener('change', () => {
    openLanguage = select.value;
    renderVoiceSection(tabsHost, panelHost, ctx);
  });
  picker.append(select);
  panel.append(picker);

  for (const [id, entry] of available.filter((e) => (e[1].languageName ?? e[1].language) === language)) {
    panel.append(piperDownloadRow(id, entry, ctx));
  }
  return panel;
}

/** Languages that still have something to download, English first, with how many each holds. */
function piperLanguages(available: Array<[string, PiperVoiceEntry]>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const [, v] of available) {
    const lang = v.languageName ?? v.language;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => {
    const rank = (lang: string): number => (isEnglish(lang) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

// ---- shared-model engines (Kokoro / Supertonic) ----------------------------

function sharedPanel(engine: 'kokoro' | 'supertonic', ctx: PanelContext): HTMLElement {
  const panel = el(document, 'div', { class: 'panel-body' });
  const info = engineInfo(engine);
  panel.append(panelHeader(info));

  const bytes = info.cacheHint ? sharedModelBytes(ctx.sizes, info.cacheHint) : 0;
  const downloaded = bytes > 0;
  const licence = engine === 'kokoro' ? ctx.manifest.kokoro.license : (ctx.manifest.supertonic?.license ?? '');
  panel.append(sharedModelRow(engine, { downloaded, bytes, licence }, ctx));

  const voices = listVoices(engine, ctx.manifest);
  if (!downloaded) {
    panel.append(
      el(document, 'p', { class: 'muted small' }, `Download the model above to use its ${voices.length} voices.`),
    );
    return panel;
  }

  panel.append(el(document, 'p', { class: 'sub-head' }, 'Voices'));
  const shown = ctx.filter
    ? voices.filter((v) => `${v.id} ${v.label} ${v.group}`.toLowerCase().includes(ctx.filter))
    : voices;
  if (shown.length === 0) {
    panel.append(el(document, 'p', { class: 'muted small' }, 'No voices match that search.'));
    return panel;
  }
  for (const voice of shown) panel.append(voiceRow(engine, voice.id, voiceLabel(voice), ctx));
  return panel;
}

/** Kokoro's voices carry their accent in the group; Supertonic's are all one language. */
function voiceLabel(voice: VoiceOption): string {
  return voice.group && !isEnglish(voice.group) ? `${voice.label} · ${voice.group}` : voice.label;
}

function sharedModelRow(
  engine: 'kokoro' | 'supertonic',
  state: { downloaded: boolean; bytes: number; licence: string },
  ctx: PanelContext,
): HTMLElement {
  const info = engineInfo(engine);
  const row = el(document, 'div', { class: 'model-row' });

  const name = el(document, 'div', { class: 'model-name' });
  name.append(
    el(document, 'b', {}, `${info.name} model`),
    el(document, 'small', {}, `${state.downloaded ? humanBytes(state.bytes) : info.approxSize} · ${state.licence}`),
  );

  // Kokoro exists at several precisions. If the installed one is not the selected one, say so
  // and offer the fetch — otherwise the row reads "downloaded" while reading still has to
  // download, and pressing Delete then Download appears to change nothing.
  const wantedPrecision = engine === 'kokoro' ? ctx.settings.kokoroDtype : null;
  const installedPrecision = engine === 'kokoro' ? kokoroInstalledPrecision(ctx.sizes) : null;
  const precisionMismatch =
    wantedPrecision != null && installedPrecision != null && wantedPrecision !== installedPrecision;
  if (engine === 'kokoro' && installedPrecision) {
    name.append(
      el(
        document,
        'small',
        { class: precisionMismatch ? 'warn' : '' },
        precisionMismatch
          ? `Installed: ${PRECISION_LABEL[installedPrecision]} — you selected ${PRECISION_LABEL[wantedPrecision]}. Download to fetch it.`
          : `Installed: ${PRECISION_LABEL[installedPrecision]}`,
      ),
    );
  }

  const progress = new RowProgress();
  // A mismatch needs a download, not a delete, even though something is already installed.
  const isDelete = state.downloaded && !precisionMismatch;
  const btn = el(document, 'button', { class: 'model-btn' }, isDelete ? 'Delete' : 'Download');
  if (isDelete) btn.classList.add('danger');

  btn.addEventListener('click', () => {
    void runModelAction(btn, async () => {
      try {
        if (isDelete) {
          await cacheClear(info.cacheHint);
          ctx.flashSaved(`${info.name} deleted`);
        } else {
          progress.start(`Downloading ${info.name}…`);
          await downloadViaWorker(engineConfigFor(ctx.settings, { engine, purpose: 'download' }), progress);
          progress.done();
          ctx.flashSaved(`${info.name} is ready`);
        }
        await ctx.refresh();
      } catch (err) {
        progress.fail(err instanceof Error ? err.message : String(err));
        btn.disabled = false;
      }
    });
  });

  row.append(el(document, 'span'), name, el(document, 'span'), el(document, 'span'), btn, progress.wrap, progress.msg);
  return row;
}
