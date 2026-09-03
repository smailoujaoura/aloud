/**
 * The "Voices & downloads" section: one collapsible panel per engine, each listing what is
 * installed and what can be added.
 *
 * Two shapes of panel, because the engines differ in what a "download" means:
 *  - **Piper** downloads per voice, so its panel is "your voices" plus a browsable catalogue of
 *    175 more, grouped by language and built lazily as groups are opened.
 *  - **Kokoro / Supertonic** download one shared model that unlocks all their voices, so their
 *    panel is a single download row followed by the voice list it enables.
 */
import { el } from '@/shared/dom';
import { humanBytes } from '@/shared/log';
import { engineInfo, rankedEngines, type EngineStanding } from '@/shared/engine-catalog';
import { isEnglish, listVoices, shortPiperLabel } from '@/shared/voice-catalog';
import { cacheClear, cacheDelete } from '@/engine/model-cache';
import { activeVoice, type EngineId, type Settings } from '@/shared/settings';
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';

import { RowProgress, downloadPiperVoice, downloadViaWorker } from './downloads';
import { previewConfig, previewFor } from './preview-button';
import { piperDownloaded, piperVoiceBytes, sharedModelBytes, type CacheSizes } from './model-status';

export interface PanelContext {
  settings: Settings;
  manifest: ModelManifest;
  sizes: CacheSizes;
  /** Lowercased text from the filter box, or '' for no filter. */
  filter: string;
  /** Re-read cache state and redraw the whole page. */
  refresh(): Promise<void>;
  /** Make (engine, voiceId) the active voice, then redraw. */
  useVoice(engine: EngineId, voiceId: string): Promise<void>;
  flashSaved(): void;
}

/**
 * Downloads and deletions are serialised across the whole page: they all mutate the same cache
 * and every one of them ends in a full redraw, so letting two run at once produces rows that
 * disagree with the cache they are describing.
 */
let modelActionBusy = false;

async function runModelAction(button: HTMLButtonElement, action: () => Promise<void>): Promise<boolean> {
  if (modelActionBusy) return false;
  modelActionBusy = true;
  button.disabled = true;
  try {
    await action();
    return true;
  } finally {
    modelActionBusy = false;
  }
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

/**
 * Language-grouped `<details>` sections. Groups are rendered lazily on first open — the Piper
 * catalogue is 175 voices, and building every row up front makes the page visibly stutter.
 */
function languageGroups<T>(
  entries: Array<[string, T]>,
  languageOf: (value: T) => string,
  opts: { openLanguage: string; filter: string; matches: (key: string, value: T) => boolean },
  renderRow: (key: string, value: T) => HTMLElement,
): HTMLElement[] {
  const byLanguage = new Map<string, Array<[string, T]>>();
  for (const entry of entries) {
    const language = languageOf(entry[1]) || 'Other';
    const bucket = byLanguage.get(language);
    if (bucket) bucket.push(entry);
    else byLanguage.set(language, [entry]);
  }

  const ordered = [...byLanguage.entries()].sort(([a], [b]) => {
    const rank = (lang: string): number => (isEnglish(lang) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const out: HTMLElement[] = [];
  for (const [language, list] of ordered) {
    const matching = opts.filter ? list.filter(([k, v]) => opts.matches(k, v)) : list;
    if (matching.length === 0) continue;

    const details = el(document, 'details', { class: 'lang-group' });
    // Open what the reader is most likely to want: anything matching a filter, their own
    // language, and English (which is where most of the catalogue's quality sits).
    details.open = Boolean(opts.filter) || isEnglish(language) || language === opts.openLanguage;
    details.appendChild(el(document, 'summary', {}, `${language} (${list.length})`));

    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      for (const [key, value] of matching) details.appendChild(renderRow(key, value));
    };
    if (details.open) build();
    else details.addEventListener('toggle', () => details.open && build(), { once: true });

    out.push(details);
  }
  return out;
}

// ---- Piper -----------------------------------------------------------------

function piperPanelBody(ctx: PanelContext): HTMLElement {
  const body = el(document, 'div', { class: 'panel-body' });
  const entries = Object.entries(ctx.manifest.piper);
  const installed = entries.filter(([, v]) => piperDownloaded(v, ctx.sizes));
  const available = entries.filter(([, v]) => !piperDownloaded(v, ctx.sizes));
  const currentLanguage =
    ctx.manifest.piper[ctx.settings.piperVoice]?.languageName ?? 'English';

  body.append(
    el(document, 'p', { class: 'sub-head' }, installed.length ? 'Your voices' : 'No Piper voices downloaded yet'),
  );

  for (const [id, entry] of installed) {
    const del = el(document, 'button', { class: 'model-btn' }, 'Delete');
    del.addEventListener('click', () => {
      void runModelAction(del, async () => {
        await Promise.all([cacheDelete(entry.config), cacheDelete(entry.onnx)]);
        ctx.flashSaved();
        await ctx.refresh();
      });
    });
    const size = humanBytes(piperVoiceBytes(entry, ctx.sizes));
    const label = `${shortPiperLabel(entry.label)} · ${entry.language} · ${entry.quality} · ${size}`;
    body.append(voiceRow('piper', id, label, ctx, del));
  }

  body.append(el(document, 'p', { class: 'sub-head' }, 'Add voices'));
  const groups = languageGroups(
    available,
    (v) => v.languageName ?? v.language,
    {
      openLanguage: currentLanguage,
      filter: ctx.filter,
      matches: (key, v) =>
        `${key} ${v.label} ${v.language} ${v.languageName ?? ''} ${v.quality}`
          .toLowerCase()
          .includes(ctx.filter),
    },
    (id, entry) => piperDownloadRow(id, entry, ctx),
  );
  body.append(
    ...(groups.length ? groups : [el(document, 'p', { class: 'muted' }, 'No voices match that filter.')]),
  );

  return body;
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
      `${entry.language} · ${entry.quality} · ${entry.sizeBytes ? humanBytes(entry.sizeBytes) : '?'}`,
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
        ctx.flashSaved();
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

// ---- shared-model engines (Kokoro / Supertonic) ----------------------------

function sharedPanelBody(engine: 'kokoro' | 'supertonic', ctx: PanelContext): HTMLElement {
  const body = el(document, 'div', { class: 'panel-body' });
  const info = engineInfo(engine);
  const bytes = info.cacheHint ? sharedModelBytes(ctx.sizes, info.cacheHint) : 0;
  const downloaded = bytes > 0;
  const licence = engine === 'kokoro' ? ctx.manifest.kokoro.license : (ctx.manifest.supertonic?.license ?? '');

  body.append(sharedModelRow(engine, { downloaded, bytes, licence }, ctx));

  if (!downloaded) {
    const count = listVoices(engine, ctx.manifest).length;
    body.append(el(document, 'p', { class: 'muted' }, `Download the model above to use its ${count} voices.`));
    return body;
  }

  const voices = listVoices(engine, ctx.manifest);
  if (engine === 'supertonic') {
    // Ten English voices — a flat list reads better than a single "English" accordion.
    for (const v of voices) {
      if (ctx.filter && !`${v.id} ${v.label}`.toLowerCase().includes(ctx.filter)) continue;
      body.append(voiceRow(engine, v.id, v.label, ctx));
    }
    return body;
  }

  const currentLanguage = ctx.manifest.kokoro.voices[ctx.settings.kokoroVoice]?.language ?? 'American English';
  body.append(
    ...languageGroups(
      voices.map((v) => [v.id, v] as [string, typeof v]),
      (v) => v.group,
      {
        openLanguage: currentLanguage,
        filter: ctx.filter,
        matches: (key, v) => `${key} ${v.label} ${v.group}`.toLowerCase().includes(ctx.filter),
      },
      (id, v) => voiceRow(engine, id, v.label, ctx),
    ),
  );
  return body;
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
    el(
      document,
      'small',
      {},
      `${state.downloaded ? humanBytes(state.bytes) : info.approxSize} · ${state.licence}`,
    ),
  );

  const progress = new RowProgress();
  const btn = el(document, 'button', { class: 'model-btn' }, state.downloaded ? 'Delete' : 'Download');
  if (state.downloaded) btn.classList.add('danger');

  btn.addEventListener('click', () => {
    void runModelAction(btn, async () => {
      try {
        if (state.downloaded) {
          await cacheClear(info.cacheHint);
        } else {
          progress.start(`Downloading ${info.name}…`);
          await downloadViaWorker(previewConfig(ctx.settings, { engine }), progress);
          progress.done();
        }
        ctx.flashSaved();
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

// ---- the section -----------------------------------------------------------

/** Chip text shown when an engine is a poor fit for this browser. */
const STANDING_WARNING: Partial<Record<EngineStanding, string>> = {
  slow: 'slow on this browser',
  unsuitable: 'not usable on this device',
};

export function renderEnginePanels(host: HTMLElement, ctx: PanelContext): void {
  // The active engine leads; the rest follow in "how well does this browser run it" order, so
  // the recommendation is visible without reading every blurb.
  const ordered = [
    engineInfo(ctx.settings.engine),
    ...rankedEngines().filter((e) => e.id !== ctx.settings.engine),
  ];

  const panels = ordered.map((info) => {
    const details = el(document, 'details', { class: 'engine-panel' });
    details.open = info.id === ctx.settings.engine || Boolean(ctx.filter);

    const summary = el(document, 'summary');
    summary.append(
      el(document, 'b', {}, info.name),
      el(document, 'span', { class: 'tag' }, info.tag),
      el(document, 'span', { class: 'panel-status' }, installedSummary(info.id, ctx)),
    );
    const warning = STANDING_WARNING[info.standing];
    if (warning) summary.append(el(document, 'span', { class: 'panel-warn' }, warning));
    details.append(summary);

    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      details.append(el(document, 'p', { class: 'panel-blurb muted' }, info.blurb));
      details.append(
        info.id === 'piper' ? piperPanelBody(ctx) : sharedPanelBody(info.id as 'kokoro' | 'supertonic', ctx),
      );
    };
    if (details.open) build();
    else details.addEventListener('toggle', () => details.open && build(), { once: true });

    return details;
  });

  host.replaceChildren(...panels);
}

function installedSummary(engine: EngineId, ctx: PanelContext): string {
  if (engine === 'piper') {
    const n = Object.values(ctx.manifest.piper).filter((v) => piperDownloaded(v, ctx.sizes)).length;
    return n ? `${n} voice${n > 1 ? 's' : ''}` : 'none yet';
  }
  const hint = engineInfo(engine).cacheHint;
  return hint && sharedModelBytes(ctx.sizes, hint) > 0 ? 'downloaded' : 'not downloaded';
}
