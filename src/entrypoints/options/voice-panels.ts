/**
 * The Voice section: who reads to you, and every voice you could switch to.
 *
 * This used to be two sections that each half-did the job — "Voice", with an engine dropdown and
 * a voice dropdown, and "Voices & downloads" further down, with tabs and radio buttons that did
 * the same thing a second way. Now it is one section, top to bottom:
 *
 *  1. **Reading with** — the current voice, large, with whether it is on this device and a
 *     preview. The one thing most visitors came to check.
 *  2. **Tabs** — one per engine, in a bar that sticks while the list scrolls, beside a search box.
 *  3. **The list** — every voice as a row with exactly one obvious next step: Download, Use, or
 *     "In use". Choosing a voice is always the same button, in every engine.
 *
 * Piper's catalogue is narrowed by language, and a voice published at several qualities is one
 * row with a quality picker rather than three near-identical rows.
 */
import { genericAvatar } from '@/ui/voice-avatar';
import { isBestVoice, voiceRank } from '@/ui/voice-quality';
import { voicePortrait } from '@/ui/voice-portraits';
import { el } from '@/shared/dom';
import { humanBytes } from '@/shared/log';
import { capabilities } from '@/shared/browser-env';
import { engineInfo, listEngines, type EngineInfo } from '@/shared/engine-catalog';
import { isEnglish, shortPiperLabel } from '@/shared/voice-catalog';
import { cacheClear, cacheDelete } from '@/engine/model-cache';
import { activeVoice, type EngineId, type Settings } from '@/shared/settings';
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';

import { RowProgress, downloadPiperVoice, downloadViaWorker } from './downloads';
import { previewFor } from './preview-button';
import { engineConfigFor } from './engine-config';
import {
  piperDownloaded,
  piperVoiceBytes,
  sharedModelBytes,
  sharedModelInstalled,
  type CacheSizes,
} from '@/engine/installed-voices';

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

export interface VoiceHosts {
  nowReading: HTMLElement;
  tabs: HTMLElement;
  panel: HTMLElement;
}

/** A search matching half the catalogue helps nobody; past this it asks for a narrower one. */
const MAX_SEARCH_RESULTS = 40;

/** Piper's quality tiers, smallest first. */
const QUALITY_ORDER = ['x_low', 'low', 'medium', 'high'];


const ACCENT_NAME: Record<string, string> = {
  'en-US': 'American English',
  'en-GB': 'British English',
};

// ---- browsing state --------------------------------------------------------
//
// Deliberately *not* settings: browsing is not choosing. Opening the Kokoro tab to look must not
// change the voice that reads the next page — only a Use button does that.

let openTab: EngineId | null = null;
let openLanguage: string | null = null;
let piperShow: 'all' | 'installed' = 'all';
/** Which quality of a multi-quality Piper voice each row is showing, by voice label. */
const variantChoice = new Map<string, string>();

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

export function renderVoiceSection(hosts: VoiceHosts, ctx: PanelContext): void {
  renderNowReading(hosts.nowReading, ctx);
  renderBrowser(hosts, ctx);
}

/** The tabs and the list under them — everything that changes while browsing. */
function renderBrowser(hosts: VoiceHosts, ctx: PanelContext): void {
  const engine = openTab ?? ctx.settings.engine;
  openTab = engine;
  const again = (): void => renderBrowser(hosts, ctx);

  hosts.tabs.replaceChildren(
    ...listEngines().map((info) =>
      engineTab(info, engine, ctx, () => {
        openTab = info.id;
        again();
      }),
    ),
  );
  hosts.panel.replaceChildren(engine === 'piper' ? piperPanel(ctx, again) : sharedPanel(engine, ctx));
}

// ---- reading with ----------------------------------------------------------

function renderNowReading(host: HTMLElement, ctx: PanelContext): void {
  const { settings, manifest, sizes } = ctx;
  const engine = settings.engine;
  const id = activeVoice(settings);
  const info = engineInfo(engine);

  let name = id;
  let meta = info.name;
  let installed = false;

  if (engine === 'piper') {
    const entry = manifest.piper[id];
    if (entry) {
      name = shortPiperLabel(entry.label);
      meta = `${info.name} · ${regionOf(entry)} · ${entry.quality}`;
      installed = piperDownloaded(entry, sizes);
    }
  } else if (engine === 'kokoro') {
    const v = manifest.kokoro.voices[id];
    if (v) {
      name = v.label;
      meta = `${info.name} · ${ACCENT_NAME[v.language] ?? v.language} · ${v.gender}`;
    }
    installed = sharedModelInstalled(engine, sizes);
  } else {
    const v = manifest.supertonic?.voices[id];
    if (v) {
      name = v.label;
      meta = `${info.name} · ${v.gender}`;
    }
    installed = sharedModelInstalled(engine, sizes);
  }

  const text = el(document, 'div', { class: 'now-text' });
  text.append(
    el(document, 'span', { class: 'now-label' }, 'Reading with'),
    el(document, 'b', { class: 'now-name' }, name),
    el(document, 'span', { class: 'now-meta' }, meta),
  );

  const status = el(
    document,
    'span',
    { class: `pill ${installed ? 'ok' : 'warn'}` },
    installed
      ? 'On this device'
      : engine === 'piper'
        ? 'Downloads the first time you read'
        : 'Model not downloaded yet',
  );

  const side = el(document, 'div', { class: 'now-side' });
  side.append(status, previewFor(engine, id, ctx));

  host.replaceChildren(avatar(engine, id, ctx, 'now-avatar'), text, side);
}

// ---- tabs ------------------------------------------------------------------

function engineTab(info: EngineInfo, open: EngineId, ctx: PanelContext, onPick: () => void): HTMLElement {
  const selected = info.id === open;
  const tab = el(document, 'button', {
    class: `voice-tab${selected ? ' is-active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': String(selected),
  });
  const label = el(document, 'span', { class: 'voice-tab-name' });
  label.append(el(document, 'b', {}, info.name));
  // The engine currently reading gets a mark, so "which one am I using" survives browsing away.
  if (info.id === ctx.settings.engine) {
    label.append(el(document, 'span', { class: 'voice-tab-dot', title: 'The engine reading to you now' }));
  }
  tab.append(label, el(document, 'span', { class: 'voice-tab-status' }, installedSummary(info.id, ctx)));
  tab.addEventListener('click', onPick);
  return tab;
}

function installedSummary(engine: EngineId, ctx: PanelContext): string {
  if (engine === 'piper') {
    const n = Object.values(ctx.manifest.piper).filter((v) => piperDownloaded(v, ctx.sizes)).length;
    return n ? `${n} on this device` : 'none downloaded';
  }
  return sharedModelInstalled(engine, ctx.sizes) ? 'downloaded' : 'not downloaded';
}

/** What the engine is and what it costs, at the top of its tab. */
function engineIntro(info: EngineInfo): HTMLElement {
  const intro = el(document, 'div', { class: 'engine-intro' });
  const chips = el(document, 'div', { class: 'engine-chips' });
  chips.append(
    el(document, 'span', { class: 'pill accent' }, info.tag),
    el(document, 'span', { class: 'pill' }, info.approxSize),
  );
  intro.append(chips, el(document, 'p', { class: 'muted small' }, info.blurb));
  if (capabilities().touchFirst && info.heavyForMobile) {
    intro.append(el(document, 'p', { class: 'small warn-text' }, 'Not recommended on a phone.'));
  }
  return intro;
}

// ---- shared pieces ---------------------------------------------------------

/**
 * A small portrait per voice (ui/voice-avatar.ts), so a long list of names can be scanned by eye
 * rather than read — and so a voice described as female or male looks it.
 */
function avatar(engine: EngineId, id: string, ctx: PanelContext, className = 'vi-avatar'): HTMLElement {
  const node = el(document, 'span', { class: className, 'aria-hidden': 'true' });
  const size = className === 'now-avatar' ? 56 : 40;
  const drawn = () => genericAvatar(document, size);
  const portrait = voicePortrait(engine, id);
  if (!portrait) {
    node.append(drawn());
    return node;
  }
  // The best voices have a face, so they are remembered by it. Not a real person: say so where
  // the face is, in the tooltip, along with who the voice sounds like.
  node.classList.add('has-photo');
  node.title = `Sounds like ${portrait.sounds}. Portrait generated — not a real person.`;
  node.removeAttribute('aria-hidden');
  const img = el(document, 'img', {
    src: portrait.file,
    alt: '',
    width: String(size),
    height: String(size),
    decoding: 'async',
    loading: 'lazy',
  });
  img.addEventListener('error', () => img.replaceWith(drawn()), { once: true });
  node.append(img);
  return node;
}

function emptyState(text: string): HTMLElement {
  return el(document, 'p', { class: 'voice-empty' }, text);
}

/** "In use", or the button that makes it so. */
function useControl(engine: EngineId, id: string, name: string, ctx: PanelContext, disabledReason?: string): HTMLElement {
  const inUse = ctx.settings.engine === engine && activeVoice(ctx.settings) === id;
  if (inUse) return el(document, 'span', { class: 'pill in-use' }, 'In use');
  const btn = el(document, 'button', { class: 'primary btn-sm', type: 'button', 'aria-label': `Use ${name}` }, 'Use');
  if (disabledReason) {
    btn.disabled = true;
    btn.title = disabledReason;
  }
  btn.addEventListener('click', () => void ctx.useVoice(engine, id));
  return btn;
}

// ---- Piper -----------------------------------------------------------------

interface PiperGroup {
  /** The manifest label, e.g. "Alba — English (GB)": one voice, whatever its quality. */
  key: string;
  name: string;
  region: string;
  language: string;
  variants: Array<[string, PiperVoiceEntry]>;
}

function regionOf(entry: PiperVoiceEntry): string {
  return entry.label.split(' — ')[1] ?? entry.languageName ?? entry.language;
}

function piperGroups(manifest: ModelManifest): PiperGroup[] {
  const byKey = new Map<string, PiperGroup>();
  for (const [id, entry] of Object.entries(manifest.piper)) {
    let group = byKey.get(entry.label);
    if (!group) {
      group = {
        key: entry.label,
        name: shortPiperLabel(entry.label),
        region: regionOf(entry),
        language: entry.languageName ?? entry.language,
        variants: [],
      };
      byKey.set(entry.label, group);
    }
    group.variants.push([id, entry]);
  }
  for (const group of byKey.values()) {
    group.variants.sort(([, a], [, b]) => QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality));
  }
  return [...byKey.values()];
}

/** The variant a row shows: the one chosen here, else the one in use, else the highest quality. */
function chosenVariant(group: PiperGroup, ctx: PanelContext): [string, PiperVoiceEntry] {
  const find = (pred: (id: string, v: PiperVoiceEntry) => boolean): [string, PiperVoiceEntry] | undefined =>
    group.variants.find(([id, v]) => pred(id, v));
  const remembered = variantChoice.get(group.key);
  return (
    (remembered ? find((id) => id === remembered) : undefined) ??
    (ctx.settings.engine === 'piper' ? find((id) => id === ctx.settings.piperVoice) : undefined) ??
    // Otherwise the best recording there is: variants are sorted smallest first, so the last is
    // `high` whenever the voice has one — offered even over a lower tier already downloaded.
    group.variants[group.variants.length - 1]!
  );
}

function anyInstalled(group: PiperGroup, ctx: PanelContext): boolean {
  return group.variants.some(([, v]) => piperDownloaded(v, ctx.sizes));
}

/**
 * Best first, then by recording quality, then by name — alphabetical order buried the handful of
 * voices actually worth choosing among 171 of them (see ui/voice-quality.ts).
 */
function byQualityThenName(ctx: PanelContext) {
  const rank = (g: PiperGroup): number =>
    voiceRank('piper', g.variants[0]![0], ctx.manifest, g.variants.map(([, v]) => v));
  return (a: PiperGroup, b: PiperGroup): number => rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/** The "Best voices" / "Other voices" headings, inserted where the best ones end. */
function withQualityHeadings<T>(list: HTMLElement, items: T[], isBest: (item: T) => boolean, render: (item: T) => HTMLElement): void {
  const best = items.filter(isBest);
  const rest = items.filter((i) => !isBest(i));
  if (best.length && rest.length) list.append(el(document, 'p', { class: 'voice-group-title' }, 'Best voices'));
  for (const item of best) list.append(render(item));
  if (best.length && rest.length) list.append(el(document, 'p', { class: 'voice-group-title' }, 'Other voices'));
  for (const item of rest) list.append(render(item));
}

function piperPanel(ctx: PanelContext, again: () => void): HTMLElement {
  const panel = el(document, 'div', { class: 'panel-body' });
  panel.append(engineIntro(engineInfo('piper')));

  const groups = piperGroups(ctx.manifest);
  const installedCount = groups.filter((g) => anyInstalled(g, ctx)).length;

  // ---- controls: language, and all / downloaded ----
  const languages = piperLanguages(groups);
  const names = languages.map(([lang]) => lang);
  const preferred = ctx.manifest.piper[ctx.settings.piperVoice]?.languageName ?? 'English';
  const language =
    (openLanguage !== null && names.includes(openLanguage) ? openLanguage : null) ??
    (names.includes(preferred) ? preferred : (names[0] ?? ''));
  openLanguage = language;

  const controls = el(document, 'div', { class: 'panel-controls' });

  const segmented = el(document, 'div', { class: 'segmented', role: 'group', 'aria-label': 'Which voices to show' });
  const showButton = (mode: 'all' | 'installed', label: string): HTMLElement => {
    const b = el(document, 'button', { type: 'button', 'aria-pressed': String(piperShow === mode) }, label);
    b.addEventListener('click', () => {
      piperShow = mode;
      again();
    });
    return b;
  };
  segmented.append(showButton('all', 'All voices'), showButton('installed', `On this device (${installedCount})`));
  controls.append(segmented);

  if (piperShow === 'all' && !ctx.filter) {
    const picker = el(document, 'label', { class: 'lang-picker' });
    const select = el(document, 'select', { 'aria-label': 'Language' });
    select.append(
      ...languages.map(([lang, count]) => {
        const option = el(document, 'option', { value: lang }, `${lang} · ${count}`);
        if (lang === language) option.selected = true;
        return option;
      }),
    );
    select.addEventListener('change', () => {
      openLanguage = select.value;
      again();
    });
    picker.append(el(document, 'span', { class: 'muted small' }, 'Language'), select);
    controls.append(picker);
  }
  panel.append(controls);

  // ---- which groups ----
  const list = el(document, 'div', { class: 'voice-list' });
  panel.append(list);
  const pool = piperShow === 'installed' ? groups.filter((g) => anyInstalled(g, ctx)) : groups;

  if (ctx.filter) {
    // A search means "find this name wherever it is", so it looks across every language.
    const matches = pool
      .filter((g) => `${g.key} ${g.language} ${g.variants.map(([id]) => id).join(' ')}`.toLowerCase().includes(ctx.filter))
      .sort(byQualityThenName(ctx));
    if (matches.length === 0) {
      list.append(emptyState('No voices match that search.'));
      return panel;
    }
    list.append(el(document, 'p', { class: 'list-note' }, `Matches from every language · ${matches.length}`));
    for (const g of matches.slice(0, MAX_SEARCH_RESULTS)) list.append(piperItem(g, ctx));
    if (matches.length > MAX_SEARCH_RESULTS) {
      list.append(emptyState(`${matches.length - MAX_SEARCH_RESULTS} more — keep typing to narrow it down.`));
    }
    return panel;
  }

  if (piperShow === 'installed') {
    if (pool.length === 0) {
      list.append(emptyState('No Piper voices on this device yet. Pick one under “All voices” and download it.'));
      return panel;
    }
    const byLanguage = new Map<string, PiperGroup[]>();
    for (const g of pool) byLanguage.set(g.language, [...(byLanguage.get(g.language) ?? []), g]);
    for (const [lang, items] of [...byLanguage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (byLanguage.size > 1) list.append(el(document, 'p', { class: 'voice-group-title' }, lang));
      for (const g of items.sort(byQualityThenName(ctx))) list.append(piperItem(g, ctx));
    }
    return panel;
  }

  const shown = pool.filter((x) => x.language === language).sort(byQualityThenName(ctx));
  withQualityHeadings(list, shown, (g) => isBestVoice('piper', g.variants[0]![0]), (g) => piperItem(g, ctx));
  return panel;
}

/** Every Piper language, English first, with how many voices each holds. */
function piperLanguages(groups: PiperGroup[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.language, (counts.get(g.language) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => {
    const rank = (lang: string): number => (isEnglish(lang) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

function piperItem(group: PiperGroup, ctx: PanelContext): HTMLElement {
  const [id, entry] = chosenVariant(group, ctx);
  const installed = piperDownloaded(entry, ctx.sizes);
  const inUse = ctx.settings.engine === 'piper' && ctx.settings.piperVoice === id;

  const item = el(document, 'div', {
    class: `voice-item${inUse ? ' is-current' : ''}${installed ? ' is-installed' : ''}`,
  });

  const main = el(document, 'div', { class: 'vi-main' });
  const size = installed ? piperVoiceBytes(entry, ctx.sizes) : (entry.sizeBytes ?? 0);
  const title = el(document, 'b', { class: 'vi-name' }, group.name);
  // The voice in use but not downloaded yet has no "In use" button to say so — it shows Download —
  // so it says so beside its name instead.
  if (inUse && !installed) title.append(el(document, 'span', { class: 'pill warn' }, 'Current'));
  main.append(
    title,
    el(document, 'span', { class: 'vi-meta' }, `${group.region} · ${entry.quality} · ${size ? humanBytes(size) : '?'}`),
  );

  // Several qualities of one voice: one row, a chip per quality. Downloaded ones are ticked.
  if (group.variants.length > 1) {
    const chips = el(document, 'div', { class: 'q-chips', role: 'group', 'aria-label': `${group.name} quality` });
    for (const [vid, v] of group.variants) {
      const have = piperDownloaded(v, ctx.sizes);
      const chip = el(
        document,
        'button',
        { type: 'button', class: `q-chip${vid === id ? ' is-selected' : ''}`, 'aria-pressed': String(vid === id) },
        `${have ? '✓ ' : ''}${v.quality.replace('_', '-')}`,
      );
      chip.title = have ? `${v.quality} — on this device` : `${v.quality} — ${v.sizeBytes ? humanBytes(v.sizeBytes) : ''}`;
      chip.addEventListener('click', () => {
        variantChoice.set(group.key, vid);
        item.replaceWith(piperItem(group, ctx));
      });
      chips.append(chip);
    }
    main.append(chips);
  }

  const actions = el(document, 'div', { class: 'vi-actions' });
  if (entry.sample) actions.append(previewFor('piper', id, ctx));

  const progress = new RowProgress();
  if (installed) {
    actions.append(useControl('piper', id, group.name, ctx));
    const remove = el(document, 'button', { class: 'ghost btn-sm remove', type: 'button', title: 'Delete from this device' }, 'Remove');
    remove.addEventListener('click', () => {
      void runModelAction(remove, async () => {
        await Promise.all([cacheDelete(entry.config), cacheDelete(entry.onnx)]);
        ctx.flashSaved(`${group.name} removed from this device`);
        await ctx.refresh();
      });
    });
    actions.append(remove);
  } else {
    const download = el(document, 'button', { class: 'btn-sm', type: 'button' }, 'Download');
    download.addEventListener('click', () => {
      void runModelAction(download, async () => {
        try {
          progress.start(`Downloading ${group.name}…`);
          await downloadPiperVoice(entry, progress);
          progress.done();
          ctx.flashSaved(inUse ? `${group.name} is ready` : `${group.name} downloaded — press Use to read with it`);
          await ctx.refresh();
        } catch (err) {
          progress.fail(err instanceof Error ? err.message : String(err));
          download.disabled = false;
        }
      });
    });
    actions.append(download);
  }

  item.append(avatar('piper', id, ctx), main, actions, progress.wrap, progress.msg);
  return item;
}

// ---- shared-model engines (Kokoro / Supertonic) ----------------------------

interface SharedVoice {
  id: string;
  name: string;
  meta: string;
  rank: number;
}

function sharedVoices(engine: 'kokoro' | 'supertonic', manifest: ModelManifest): SharedVoice[] {
  if (engine === 'kokoro') {
    // Best first, then by Kokoro's own grades: the accent is in each row instead of being the
    // thing the list is sorted by, so the voices worth hearing are the ones at the top.
    return Object.entries(manifest.kokoro.voices)
      .map(([id, v]) => ({
        id,
        name: v.label,
        meta: [ACCENT_NAME[v.language] ?? v.language, v.gender, v.grade ? `grade ${v.grade}` : '']
          .filter(Boolean)
          .join(' · '),
        rank: voiceRank('kokoro', id, manifest),
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }
  return Object.entries(manifest.supertonic?.voices ?? {}).map(([id, v]) => ({
    id,
    name: v.label,
    meta: v.gender,
    rank: 0,
  }));
}

function sharedPanel(engine: 'kokoro' | 'supertonic', ctx: PanelContext): HTMLElement {
  const panel = el(document, 'div', { class: 'panel-body' });
  const info = engineInfo(engine);
  const bytes = info.cacheHint ? sharedModelBytes(ctx.sizes, info.cacheHint) : 0;
  const downloaded = sharedModelInstalled(engine, ctx.sizes);
  panel.append(engineIntro(info), modelCard(engine, { downloaded, bytes }, ctx));

  const voices = sharedVoices(engine, ctx.manifest).filter(
    (v) => !ctx.filter || `${v.id} ${v.name} ${v.meta}`.toLowerCase().includes(ctx.filter),
  );
  const list = el(document, 'div', { class: `voice-list${downloaded ? '' : ' is-locked'}` });
  panel.append(list);

  if (voices.length === 0) {
    list.append(emptyState('No voices match that search.'));
    return panel;
  }
  if (!downloaded) {
    list.append(el(document, 'p', { class: 'list-note' }, `Download the model above to use these ${voices.length} voices.`));
  }

  const item = (v: SharedVoice): HTMLElement => {
    const inUse = ctx.settings.engine === engine && activeVoice(ctx.settings) === v.id;
    const row = el(document, 'div', { class: `voice-item${inUse ? ' is-current' : ''}` });
    const main = el(document, 'div', { class: 'vi-main' });
    main.append(el(document, 'b', { class: 'vi-name' }, v.name), el(document, 'span', { class: 'vi-meta' }, v.meta));
    const actions = el(document, 'div', { class: 'vi-actions' });
    actions.append(
      previewFor(engine, v.id, ctx),
      useControl(engine, v.id, v.name, ctx, downloaded ? undefined : `Download ${info.name} first`),
    );
    row.append(avatar(engine, v.id, ctx), main, actions);
    return row;
  };
  withQualityHeadings(list, voices, (v) => isBestVoice(engine, v.id), item);
  return panel;
}

function modelCard(
  engine: 'kokoro' | 'supertonic',
  state: { downloaded: boolean; bytes: number },
  ctx: PanelContext,
): HTMLElement {
  const info = engineInfo(engine);
  const licence = engine === 'kokoro' ? ctx.manifest.kokoro.license : (ctx.manifest.supertonic?.license ?? '');
  const card = el(document, 'div', { class: `model-card${state.downloaded ? ' is-installed' : ''}` });

  const text = el(document, 'div', { class: 'mc-text' });
  text.append(
    el(document, 'b', {}, state.downloaded ? `${info.name} is on this device` : `${info.name} model`),
    el(document, 'span', { class: 'vi-meta' }, `${state.downloaded ? humanBytes(state.bytes) : info.approxSize} · ${licence}`),
  );
  // A machine with a GPU reads with Kokoro's full-precision build — the quantised one returns
  // noise instead of speech on WebGPU — so say that a larger download happens once, rather than
  // letting it appear from nowhere on the first page.
  if (engine === 'kokoro' && ctx.settings.preferWebGPU && capabilities().workerWebGPU) {
    text.append(
      el(
        document,
        'span',
        { class: 'vi-meta' },
        'This machine reads with the GPU, which uses Kokoro’s full-precision build: a larger download, once, the first time you read.',
      ),
    );
  }

  const progress = new RowProgress();
  const isDelete = state.downloaded;
  const btn = el(
    document,
    'button',
    { class: isDelete ? 'ghost danger btn-sm' : 'primary', type: 'button' },
    isDelete ? 'Delete model' : `Download ${info.approxSize.replace(/\s*\(.*\)/, '')}`,
  );

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
          ctx.flashSaved(`${info.name} is ready — pick a voice below`);
        }
        await ctx.refresh();
      } catch (err) {
        progress.fail(err instanceof Error ? err.message : String(err));
        btn.disabled = false;
      }
    });
  });

  card.append(text, btn, progress.wrap, progress.msg);
  return card;
}
