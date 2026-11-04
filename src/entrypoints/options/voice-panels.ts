/**
 * The Voice section: who reads to you, and every voice you could switch to.
 *
 * This used to be two sections that each half-did the job — "Voice", with an engine dropdown and
 * a voice dropdown, and "Voices & downloads" further down, with tabs and radio buttons that did
 * the same thing a second way. Now it is one section, top to bottom:
 *
 *  1. **Who reads what** — the switchboard (voice-board.ts): each language and the voice reading
 *     it, chosen right there. It replaced a "Reading with" card that chose a second way.
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
import { downloadSize, engineInfo, kokoroVoiceUrl, phononVoiceUrl, supertonicStyleUrl, listEngines, type EngineInfo } from '@/shared/engine-catalog';
import { phononExperimental } from '@/shared/phonon-voices';
import { isEnglish, listVoices, shortPiperLabel } from '@/shared/voice-catalog';
import { serverAddressProblem, serverBase, serverHeaders, serverOrigin, voicesFrom, voicesUrl } from '@/shared/server-voices';
import { getServerKey, setServerKey } from '@/shared/server-key';
import { disposePreview } from '@/ui/voice-preview';
import { browser } from 'wxt/browser';
import { languageName, primaryLanguage, voiceLanguage } from '@/shared/language-voice';
import { supertonicVoices } from '@/shared/supertonic-voices';
import { renderVoiceBoard } from './voice-board';
import { cacheClear, cacheDelete, deleteModels } from '@/engine/model-cache';
import { activeVoice, type EngineId, type ServerSettings, type Settings } from '@/shared/settings';
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';

import {
  RowProgress,
  announceModelsChanged,
  downloadPiperVoice,
  downloadTray,
  downloadSharedModel,
  followDownload,
  newDownloadScope,
} from './downloads';
import { DownloadCancelled, downloads } from './download-queue';
import { previewFor } from './preview-button';
import { engineConfigFor, readsOnGpu } from './engine-config';
import {
  engineDownloaded,
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
  /** Choose who reads `language` (for your own voice's language: your voice), then redraw. */
  chooseVoice(language: string, engine: EngineId, voiceId: string): Promise<void>;
  /** A language no downloaded voice speaks: read in English, or skipped. */
  setUnvoiced(choice: 'english' | 'skip'): Promise<void>;
  /** Take a language off the board (read like every other language), or bring it back. */
  setLanguageRemoved(language: string, removed: boolean): Promise<void>;
  /** The voice for every other language (null: automatic, the voice English gets). */
  setOtherVoice(voice: { engine: EngineId; voice: string } | null): Promise<void>;
  flashSaved(message?: string): void;
  /** Say what went wrong. */
  flashError(message: string): void;
  /** Choose a language's voice (null: automatic), then redraw. */
  setLanguageVoice(language: string, voice: { engine: EngineId; voice: string } | null): Promise<void>;
  /** Switch voices with each passage's language, or not. */
  setAutoLanguage(on: boolean): Promise<void>;
  /** Save the reader's own speech server (empty address: none), then redraw. */
  setServer(server: ServerSettings): Promise<void>;
}

export interface VoiceHosts {
  /** "Who reads what": the switchboard of languages and voices (voice-board.ts). */
  board: HTMLElement;
  /** The catalogue: every voice, to browse and download. */
  catalogue: HTMLElement;
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
  es: 'Spanish',
  'fr-FR': 'French',
  hi: 'Hindi',
  it: 'Italian',
  'pt-BR': 'Brazilian Portuguese',
};

/** A voice's language as the lists say it: "Italian", not "it". */
function accentName(tag: string): string {
  return ACCENT_NAME[tag] ?? languageName(tag);
}

// ---- browsing state --------------------------------------------------------
//
// Deliberately *not* settings: browsing is not choosing. Opening the Kokoro tab to look must not
// change the voice that reads the next page — only a Use button does that.

let openTab: EngineId | null = null;
let openLanguage: string | null = null;
type SharedEngine = 'kokoro' | 'supertonic' | 'phonon';
/** The language open in each shared-model engine's list — its own, so switching tabs does not cross them. */
const sharedLanguage = new Map<SharedEngine, string>();
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
  // To the catalogue, at a language to find a voice for.
  const openCatalogue = (language?: string, _hidden?: boolean, engine?: EngineId): void => {
    if (language) askedLanguage = language;
    if (engine) askedEngine = engine;
    renderBrowser(hosts, ctx);
    hosts.catalogue.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  renderVoiceBoard(hosts.board, ctx, openCatalogue);
  renderBrowser(hosts, ctx);
}

/**
 * `?language=it`: opened from the reader, which met a passage in a language with no voice. The
 * list opens on that language — Piper's, which has the most — once, then browsing is the reader's.
 */
let askedLanguage: string | null = new URLSearchParams(globalThis.location?.search ?? '').get('language');

/** The engine to open on with `askedLanguage`, when the caller knows which it wants. */
let askedEngine: EngineId | null = null;

function openAskedLanguage(manifest: ModelManifest): void {
  const code = askedLanguage;
  const engine = askedEngine;
  askedLanguage = null;
  askedEngine = null;
  if (!code) return;
  const piper = Object.values(manifest.piper).find((v) => primaryLanguage(v.language) === code);
  const kokoro = sharedVoices('kokoro', manifest).find((v) => primaryLanguage(manifest.kokoro.voices[v.id]?.language) === code);
  if (kokoro) sharedLanguage.set('kokoro', kokoro.group);
  if (engine === 'kokoro' && kokoro) {
    openTab = 'kokoro';
    return;
  }
  if (engine === 'supertonic' && manifest.supertonic?.languages?.includes(code)) {
    openTab = 'supertonic';
    sharedLanguage.set('supertonic', languageName(code));
    return;
  }
  const phonon = sharedVoices('phonon', manifest).find((v) => primaryLanguage(manifest.phonon?.voices[v.id]?.language) === code);
  if (engine === 'phonon' && phonon) {
    openTab = 'phonon';
    sharedLanguage.set('phonon', phonon.group);
    return;
  }
  if (piper) {
    openTab = 'piper';
    openLanguage = piper.languageName ?? null;
  } else if (kokoro) {
    openTab = 'kokoro';
  }
}

/** The tabs and the list under them — everything that changes while browsing. */
function renderBrowser(hosts: VoiceHosts, ctx: PanelContext): void {
  // The rows about to be replaced stop following the download queue now (downloads.ts).
  newDownloadScope();
  openAskedLanguage(ctx.manifest);
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
  // The download line sits above whichever engine is open: one started on the Piper tab is still
  // worth seeing from the Kokoro one.
  hosts.panel.replaceChildren(
    downloadTray(),
    engine === 'piper' ? piperPanel(ctx, again) : engine === 'server' ? serverPanel(ctx) : sharedPanel(engine, ctx, again),
  );
}

// ---- reading with ----------------------------------------------------------

// ---- tabs ------------------------------------------------------------------

function engineTab(info: EngineInfo, open: EngineId, ctx: PanelContext, onPick: () => void): HTMLElement {
  const selected = info.id === open;
  const tab = el(document, 'button', {
    class: `voice-tab${selected ? ' is-active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': String(selected),
  });
  // One short row: whether it is here (a mark, its words in the tooltip) and the short name. "Your
  // own server · not downloaded" and "4 on this device" made the tabs overflow a phone's width. The
  // engine reading now is said in the tooltip only: a dot for it looked like a recommendation.
  const status = installedSummary(info.id, ctx);
  const ready = engineDownloaded(info.id, ctx.manifest, ctx.sizes);
  const reading = info.id === ctx.settings.engine;
  const label = el(document, 'span', { class: 'voice-tab-name' });
  label.append(
    el(document, 'span', { class: `voice-tab-mark${ready ? ' is-ready' : ''}`, 'aria-hidden': 'true' }, ready ? '✓' : info.id === 'server' ? '+' : '↓'),
    el(document, 'b', {}, info.short),
  );
  tab.title = `${info.name}: ${status}${reading ? ' · reading to you now' : ''}`;
  tab.setAttribute('aria-label', tab.title);
  tab.append(label);
  tab.addEventListener('click', onPick);
  // On a phone the strip scrolls: the open tab is brought into it.
  if (selected) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  return tab;
}

function installedSummary(engine: EngineId, ctx: PanelContext): string {
  if (engine === 'piper') {
    const n = Object.values(ctx.manifest.piper).filter((v) => piperDownloaded(v, ctx.sizes)).length;
    return n ? `${n} voice${n === 1 ? '' : 's'} on this device` : 'none downloaded';
  }
  // The reader's own server is never downloaded: it is set up or not (it said "not downloaded").
  if (engine === 'server') return engineDownloaded('server', ctx.manifest, ctx.sizes) ? 'connected' : 'not set up';
  return sharedModelInstalled(engine, ctx.sizes) ? 'on this device' : 'not downloaded';
}

/** What the engine is and what it costs, at the top of its tab. */
function engineIntro(info: EngineInfo, onGpu = false): HTMLElement {
  const intro = el(document, 'div', { class: 'engine-intro' });
  const chips = el(document, 'div', { class: 'engine-chips' });
  chips.append(
    el(document, 'span', { class: 'pill accent' }, info.tag),
    el(document, 'span', { class: 'pill' }, downloadSize(info, onGpu)),
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
  node.title = `Sounds like ${portrait.sounds}. Generated portrait, not a real person.`;
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

/**
 * "Reads Italian" for a voice that does, or "Use", which asks what for: the voice's own language,
 * or every other language. One click chose a voice a second way, for a purpose it did not say.
 */
function useControl(engine: EngineId, id: string, name: string, ctx: PanelContext, disabledReason?: string): HTMLElement {
  const language = primaryLanguage(voiceLanguage(engine, id, ctx.manifest));
  const chosen = ctx.settings.languageVoices[language];
  const other = ctx.settings.otherVoice;
  const readsOwn = chosen ? chosen.engine === engine && chosen.voice === id : ctx.settings.engine === engine && activeVoice(ctx.settings) === id;
  const readsOther = !!other && other.engine === engine && other.voice === id;
  if (disabledReason) {
    const btn = el(document, 'button', { class: 'primary btn-sm', type: 'button', 'aria-label': `Use ${name}`, title: disabledReason }, 'Use');
    btn.disabled = true;
    return btn;
  }
  const wrap = el(document, 'span', { class: 'use-wrap' });
  const menu = el(document, 'details', { class: 'use-menu' }) as HTMLDetailsElement;
  const summary = el(document, 'summary', { class: 'btn primary btn-sm', 'aria-label': `Use ${name} for…` }, 'Use');
  const list = el(document, 'div', { class: 'use-list', role: 'menu' });
  const option = (label: string, run: () => void): void => {
    const item = el(document, 'button', { type: 'button', role: 'menuitem' }, label);
    item.addEventListener('click', () => {
      menu.open = false;
      run();
    });
    list.append(item);
  };
  if (!readsOwn) option(`For ${languageName(language)}`, () => void ctx.chooseVoice(language, engine, id));
  if (!readsOther) option('For every other language', () => void ctx.chooseVoice('*', engine, id));
  // One open at a time, and closed by a click anywhere else.
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const m of document.querySelectorAll<HTMLDetailsElement>('details.use-menu[open]')) if (m !== menu) m.open = false;
    const close = (e: Event): void => {
      if (!menu.contains(e.target as Node)) {
        menu.open = false;
        document.removeEventListener('click', close, true);
      }
    };
    document.addEventListener('click', close, true);
  });
  menu.append(summary, list);
  wrap.append(menu);
  return wrap;
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

/**
 * The variant a row shows: the one chosen here, else the one in use, else the best one already
 * downloaded, else `medium`. A `high` model is several times the work and falls behind speech on
 * many computers; it stays a click away.
 */
function chosenVariant(group: PiperGroup, ctx: PanelContext): [string, PiperVoiceEntry] {
  const find = (pred: (id: string, v: PiperVoiceEntry) => boolean): [string, PiperVoiceEntry] | undefined =>
    group.variants.find(([id, v]) => pred(id, v));
  const remembered = variantChoice.get(group.key);
  return (
    (remembered ? find((id) => id === remembered) : undefined) ??
    (ctx.settings.engine === 'piper' ? find((id) => id === ctx.settings.piperVoice) : undefined) ??
    [...group.variants].reverse().find(([, v]) => piperDownloaded(v, ctx.sizes)) ??
    find((_, v) => v.quality === 'medium') ??
    // No medium: the best there is (variants are sorted smallest first).
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

  // ---- control: language ----
  const languages = piperLanguages(groups);
  const names = languages.map(([lang]) => lang);
  const preferred = ctx.manifest.piper[ctx.settings.piperVoice]?.languageName ?? 'English';
  const language =
    (openLanguage !== null && names.includes(openLanguage) ? openLanguage : null) ??
    (names.includes(preferred) ? preferred : (names[0] ?? ''));
  openLanguage = language;

  if (!ctx.filter) {
    const controls = el(document, 'div', { class: 'panel-controls' });
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
    panel.append(controls);
  }

  // ---- which groups: the ones on this device first, with no heading of their own ----
  const list = el(document, 'div', { class: 'voice-list' });
  panel.append(list);
  const downloadedFirst = (a: PiperGroup, b: PiperGroup): number => Number(anyInstalled(b, ctx)) - Number(anyInstalled(a, ctx));

  if (ctx.filter) {
    // A search means "find this name wherever it is", so it looks across every language.
    const matches = groups
      .filter((g) => `${g.key} ${g.language} ${g.variants.map(([id]) => id).join(' ')}`.toLowerCase().includes(ctx.filter))
      .sort((a, b) => downloadedFirst(a, b) || byQualityThenName(ctx)(a, b));
    if (matches.length === 0) {
      list.append(emptyState('No voices match that search.'));
      return panel;
    }
    list.append(el(document, 'p', { class: 'list-note' }, `Matches from every language · ${matches.length}`));
    for (const g of matches.slice(0, MAX_SEARCH_RESULTS)) list.append(piperItem(g, ctx));
    if (matches.length > MAX_SEARCH_RESULTS) {
      list.append(emptyState(`${matches.length - MAX_SEARCH_RESULTS} more. Keep typing to narrow it down.`));
    }
    return panel;
  }

  const inLanguage = groups.filter((x) => x.language === language).sort(byQualityThenName(ctx));
  for (const g of inLanguage.filter((g) => anyInstalled(g, ctx))) list.append(piperItem(g, ctx));
  withQualityHeadings(list, inLanguage.filter((g) => !anyInstalled(g, ctx)), (g) => isBestVoice('piper', g.variants[0]![0]), (g) => piperItem(g, ctx));
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
  /** Ends this row's following of the download queue (an installed row follows nothing). */
  let stopFollowing: () => void = () => undefined;
  const installed = piperDownloaded(entry, ctx.sizes);
  // No row is marked as "the" voice: each language has its own, and the board above says which.
  // Marking the engine's saved voice lit up Alba and Heart whether anything read with them or not.
  const item = el(document, 'div', { class: `voice-item${installed ? ' is-installed' : ''}` });

  const main = el(document, 'div', { class: 'vi-main' });
  const size = installed ? piperVoiceBytes(entry, ctx.sizes) : (entry.sizeBytes ?? 0);
  const title = el(document, 'b', { class: 'vi-name' }, group.name);
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
      chip.title = have ? `${v.quality} · on this device` : `${v.quality} · ${v.sizeBytes ? humanBytes(v.sizeBytes) : ''}`;
      chip.addEventListener('click', () => {
        variantChoice.set(group.key, vid);
        // This row is replaced on its own: it stops following the download queue now, not at
        // the next whole-list redraw (sixty quality changes kept sixty dead rows alive).
        stopFollowing();
        item.replaceWith(piperItem(group, ctx));
      });
      chips.append(chip);
    }
    main.append(chips);
  }

  const actions = el(document, 'div', { class: 'vi-actions' });

  const progress = new RowProgress();
  if (installed) {
    // Remove first, away from Use: the one action here that takes something away.
    const remove = el(document, 'button', { class: 'btn-sm remove', type: 'button', title: 'Delete from this device' }, 'Remove');
    remove.addEventListener('click', () => {
      void runModelAction(remove, async () => {
        try {
          // Not while a download or a voice loading anywhere could write it back (deleteModels).
          await deleteModels(() => Promise.all([cacheDelete(entry.config), cacheDelete(entry.onnx)]).then(() => undefined));
          announceModelsChanged();
          ctx.flashSaved(`${group.name} removed from this device`);
          await ctx.refresh();
        } catch (err) {
          ctx.flashError(err instanceof Error ? err.message : String(err));
          remove.disabled = false;
        }
      });
    });
    actions.append(remove);
    if (entry.sample) actions.append(previewFor('piper', id, ctx));
    actions.append(useControl('piper', id, group.name, ctx));
  } else {
    if (entry.sample) actions.append(previewFor('piper', id, ctx));
    const download = el(document, 'button', { class: 'btn-sm', type: 'button' }, 'Download');
    const key = `piper:${id}`;
    download.addEventListener('click', () => {
      // Queued behind any download already running; the row says so (followDownload).
      downloads.enqueue(key, group.name, (p, signal) => downloadPiperVoice(entry, p, signal)).then(
        async () => {
          announceModelsChanged();
          ctx.flashSaved(`${group.name} downloaded. Press Use to read with it`);
          await ctx.refresh();
        },
        (err: unknown) => {
          if (err instanceof DownloadCancelled) ctx.flashSaved(`${group.name}: download cancelled`);
        },
      );
    });
    stopFollowing = followDownload(key, progress, download, 'Download');
    actions.append(download);
  }

  item.append(avatar('piper', id, ctx), main, actions, progress.wrap, progress.msg);
  return item;
}

// ---- shared-model engines (Phonon / Kokoro / Supertonic) -------------------

interface SharedVoice {
  id: string;
  name: string;
  meta: string;
  rank: number;
  /** The language it is listed under: "English" for both accents, "Italian", … */
  group: string;
  /** What the voice sounds like, in its makers' words (Phonon's catalogue has one per voice). */
  description?: string;
}

function sharedVoices(engine: SharedEngine, manifest: ModelManifest): SharedVoice[] {
  if (engine === 'phonon') {
    const m = manifest.phonon;
    if (!m) return [];
    // In the catalogue's order: American, British and the characters, then each experimental language.
    return Object.entries(m.voices).map(([id, v]) => {
      const experimental = phononExperimental(v.language, m.experimentalLanguages);
      return {
        id,
        name: v.label,
        meta: [v.character ? 'Character' : accentName(v.language), v.gender, experimental ? 'experimental' : ''].filter(Boolean).join(' · '),
        rank: 0,
        // "French (experimental)" in the language list too, not only on each voice.
        group: v.language.startsWith('en') ? 'English' : `${languageName(primaryLanguage(v.language))}${experimental ? ' (experimental)' : ''}`,
        description: v.description,
      };
    });
  }
  if (engine === 'kokoro') {
    // Every Kokoro voice is a good one: no grades and no "best" heading, just by name.
    return Object.entries(manifest.kokoro.voices)
      .map(([id, v]) => ({
        id,
        name: v.label,
        meta: [accentName(v.language), v.gender].filter(Boolean).join(' · '),
        rank: 0,
        group: v.language.startsWith('en') ? 'English' : accentName(v.language),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // Every style in every language (`F1@de`), grouped by language: ten voices to a language.
  return supertonicVoices(manifest).map((v) => ({
    id: v.id,
    name: v.label,
    meta: [languageName(v.language), v.gender].join(' · '),
    rank: 0,
    group: languageName(v.language),
  }));
}

function sharedPanel(engine: SharedEngine, ctx: PanelContext, again: () => void): HTMLElement {
  const panel = el(document, 'div', { class: 'panel-body' });
  const info = engineInfo(engine);
  const bytes = info.cacheHint ? sharedModelBytes(ctx.sizes, info.cacheHint) : 0;
  const downloaded = sharedModelInstalled(engine, ctx.sizes);
  panel.append(engineIntro(info, readsOnGpu(ctx.settings)), modelCard(engine, { downloaded, bytes }, ctx));

  const all = sharedVoices(engine, ctx.manifest);

  // ---- language, as Piper's list has it: one language at a time ----
  const counts = new Map<string, number>();
  for (const v of all) counts.set(v.group, (counts.get(v.group) ?? 0) + 1);
  const languages = [...counts.keys()].sort((a, b) => (a === 'English' ? -1 : b === 'English' ? 1 : a.localeCompare(b)));
  const saved = engine === 'kokoro' ? ctx.settings.kokoroVoice : engine === 'phonon' ? ctx.settings.phononVoice : ctx.settings.supertonicVoice;
  const current = all.find((v) => v.id === saved)?.group ?? 'English';
  const remembered = sharedLanguage.get(engine) ?? null;
  const language =
    (remembered !== null && languages.includes(remembered) ? remembered : null) ??
    (languages.includes(current) ? current : (languages[0] ?? 'English'));
  sharedLanguage.set(engine, language);
  // A search means "find this name wherever it is", so it looks across every language.
  const picking = languages.length > 1 && !ctx.filter;
  if (picking) {
    const controls = el(document, 'div', { class: 'panel-controls' });
    const picker = el(document, 'label', { class: 'lang-picker' });
    const select = el(document, 'select', { 'aria-label': 'Language' });
    select.append(
      ...languages.map((lang) => {
        const option = el(document, 'option', { value: lang }, `${lang} · ${counts.get(lang)}`);
        if (lang === language) option.selected = true;
        return option;
      }),
    );
    select.addEventListener('change', () => {
      sharedLanguage.set(engine, select.value);
      again();
    });
    picker.append(el(document, 'span', { class: 'muted small' }, 'Language'), select);
    controls.append(picker);
    panel.append(controls);
  }

  const inView = all.filter(
    (v) => (picking ? v.group === language : true) && (!ctx.filter || `${v.id} ${v.name} ${v.meta} ${v.description ?? ''}`.toLowerCase().includes(ctx.filter)),
  );
  const voices = inView;
  const list = el(document, 'div', { class: `voice-list${downloaded ? '' : ' is-locked'}` });
  panel.append(list);

  if (voices.length === 0) {
    list.append(emptyState('No voices match that search.'));
    return panel;
  }
  if (!downloaded) {
    list.append(el(document, 'p', { class: 'list-note' }, all.length === voices.length
        ? `Download the model above to use these ${voices.length} voices.`
        : `Download the model above to use these voices. One download for all ${all.length}.`));
  }

  const item = (v: SharedVoice): HTMLElement => {
    const row = el(document, 'div', { class: 'voice-item' });
    const main = el(document, 'div', { class: 'vi-main' });
    main.append(el(document, 'b', { class: 'vi-name' }, v.name), el(document, 'span', { class: 'vi-meta' }, v.meta));
    // What the voice sounds like (Phonon's catalogue describes each one): one line, all of it on hover.
    if (v.description) main.append(el(document, 'span', { class: 'vi-desc', title: v.description }, v.description));
    const actions = el(document, 'div', { class: 'vi-actions' });
    actions.append(
      previewFor(engine, v.id, ctx),
      useControl(engine, v.id, v.name, ctx, downloaded ? undefined : `Download ${info.name} first`),
    );
    row.append(avatar(engine, v.id, ctx), main, actions);
    return row;
  };
  if (ctx.filter && languages.length > 1) {
    list.append(el(document, 'p', { class: 'list-note' }, `Matches from every language · ${voices.length}`));
  }
  // No grades and no "best" heading: every voice of a shared model, just in order.
  for (const v of voices) list.append(item(v));
  return panel;
}

// ---- your own server ------------------------------------------------------

/**
 * The reader's own speech server (issue #9): an address, Connect, and then its voices, each
 * previewed and used like any other. Connect asks for permission to reach that one host, and on
 * Firefox for consent to send page text there, since that is what reading through it does.
 */
function serverPanel(ctx: PanelContext): HTMLElement {
  const panel = el(document, 'div', { class: 'panel-body' });
  const info = engineInfo('server');
  panel.append(engineIntro(info));
  const { server } = ctx.settings;

  const form = el(document, 'div', { class: 'server-form' });
  const url = el(document, 'input', {
    type: 'url',
    class: 'server-url',
    placeholder: 'http://localhost:8880/v1',
    'aria-label': 'Server address',
    spellcheck: 'false',
    value: server.url,
  });
  const model = el(document, 'input', {
    type: 'text',
    class: 'server-model',
    placeholder: 'Model (optional)',
    'aria-label': 'Model',
    title: 'The model name to send. Kokoro-FastAPI accepts kokoro; most servers accept tts-1, which is sent if this is empty.',
    spellcheck: 'false',
    value: server.model,
  });
  // Shown as dots, never filled in: a saved key is said to be saved, and stays where it is unless
  // something is typed here (shared/server-key.ts).
  const key = el(document, 'input', {
    type: 'password',
    class: 'server-key',
    placeholder: 'Key (optional)',
    'aria-label': 'Key',
    title: 'For a server that asks for one: sent as "Authorization: Bearer <key>", only to this server. Kept on this device, never in backups.',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const connect = el(document, 'button', { type: 'button', class: 'primary btn-sm' }, server.url ? 'Check again' : 'Connect');
  const status = el(document, 'p', { class: 'muted small server-status', role: 'status' });
  form.append(url, model, key, connect);
  panel.append(form, status);
  void getServerKey(server.url).then((saved) => {
    if (saved) key.placeholder = 'Key saved (type to replace)';
  });

  connect.addEventListener('click', () => {
    const base = serverBase(url.value);
    if (!base) {
      status.textContent = 'Enter the address of an OpenAI-style speech server, starting with http:// or https://.';
      return;
    }
    const problem = serverAddressProblem(base);
    if (problem) {
      status.textContent = problem;
      return;
    }
    connect.disabled = true;
    status.textContent = 'Connecting…';
    // Asked for first, while the click still counts as the reader's gesture.
    void askForServer(base)
      .then(async (granted) => {
        if (!granted) {
          status.textContent = 'Aloud needs your permission to reach that address. Nothing was changed.';
          return;
        }
        const typed = key.value.trim();
        // A saved key belongs to the server it was saved for (scheme, host and port), and is never
        // sent to another one (shared/server-key.ts). Permissions are per host.
        const before = server.url ? new URL(server.url).hostname : '';
        const sameHost = before === new URL(base).hostname;
        const sameServer = !!server.url && new URL(server.url).origin === new URL(base).origin;
        const useKey = typed || (await getServerKey(base));
        let refused = false;
        const voices = await fetch(voicesUrl(base), { headers: serverHeaders(useKey), signal: AbortSignal.timeout(10_000) })
          .then((r) => {
            refused = r.status === 401 || r.status === 403;
            return r.ok ? r.json() : null;
          })
          .then((answer) => (answer === null ? null : voicesFrom(answer)))
          .catch(() => null);
        if (refused) {
          status.textContent = useKey ? `${base} refused the key. Check it and connect again.` : `${base} asks for a key. Enter it and connect again.`;
          return;
        }
        if (voices === null) {
          status.textContent = `Can't reach ${base}. Is the server running, and is the address right (it usually ends in /v1)?`;
          return;
        }
        if (voices.length === 0) {
          status.textContent = `Connected, but ${base} lists no voices at /audio/voices.`;
          return;
        }
        if (typed || !sameServer) {
          // The key typed, or none: another host's key is forgotten with it.
          await setServerKey(typed, base);
          // A warm preview worker holds the old key.
          disposePreview();
        }
        // Moved to another host: the old one's permission goes, unless a site list still uses it.
        if (before && !sameHost && !hostStillNeeded(ctx.settings, before)) {
          void browser.permissions.remove({ origins: [serverOrigin(server.url)] }).catch(() => false);
        }
        await ctx.setServer({ url: base, model: model.value.trim(), voices });
        ctx.flashSaved(`Connected: ${voices.length} voice${voices.length === 1 ? '' : 's'}`);
      })
      .finally(() => {
        connect.disabled = false;
      });
  });

  if (!server.url) {
    panel.append(
      el(document, 'p', { class: 'list-note' }, 'Runs on any OpenAI-style speech server: Kokoro-FastAPI, openedai-speech and others. Text goes only to the address you enter.'),
    );
    return panel;
  }

  const remove = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Remove server');
  remove.addEventListener('click', () => {
    const origin = serverOrigin(server.url);
    // Not when a site list still starts something on that host: the grant is shared.
    if (!hostStillNeeded(ctx.settings, new URL(server.url).hostname)) void browser.permissions.remove({ origins: [origin] }).catch(() => false);
    void setServerKey('').then(disposePreview);
    void ctx.setServer({ url: '', model: '', voices: [] });
  });
  status.textContent = `${server.url} · ${server.voices.length} voice${server.voices.length === 1 ? '' : 's'}`;
  status.append(' ', remove);

  const list = el(document, 'div', { class: 'voice-list' });
  for (const v of listVoices('server', ctx.manifest)) {
    if (ctx.filter && !v.id.toLowerCase().includes(ctx.filter)) continue;
    const row = el(document, 'div', { class: 'voice-item' });
    const main = el(document, 'div', { class: 'vi-main' });
    main.append(el(document, 'b', { class: 'vi-name' }, v.id), el(document, 'span', { class: 'vi-meta' }, languageName(v.group)));
    const actions = el(document, 'div', { class: 'vi-actions' });
    actions.append(previewFor('server', v.id, ctx), useControl('server', v.id, v.id, ctx));
    row.append(avatar('server', v.id, ctx), main, actions);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

/**
 * Does a site list in Settings (highlights or the speed control starting by themselves) rely on
 * Aloud's permission for `hostname`? Removing a server must not take that permission with it:
 * a server on the same machine as a site those lists name shares the grant.
 */
export function hostStillNeeded(settings: Pick<Settings, 'annotate' | 'mediaSpeed'>, hostname: string): boolean {
  const sites = [...settings.annotate.alwaysOn, ...settings.mediaSpeed.alwaysOn];
  return sites.some((site) => site === '*' || hostname === site || hostname.endsWith(`.${site}`));
}

/**
 * Permission to reach the server's host, and on Firefox consent to send it page text (the
 * optional "website content" data permission). Both from the reader's click.
 */
async function askForServer(base: string): Promise<boolean> {
  const origins = [serverOrigin(base)];
  if (import.meta.env.BROWSER === 'firefox') {
    try {
      return await browser.permissions.request({ origins, data_collection: ['websiteContent'] } as never);
    } catch {
      /* a Firefox without data-collection permissions: ask for the host alone */
    }
  }
  return browser.permissions.request({ origins });
}

/**
 * "75 MB · CC BY-NC 4.0: …", the licence a link where the model's licence asks for one (Creative
 * Commons: credit, and a link to the licence).
 */
function licenceLine(before: string, licence: string, url: string | undefined): HTMLElement {
  const line = el(document, 'span', { class: 'vi-meta' }, before);
  if (!url) line.append(licence);
  else line.append(el(document, 'a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, licence));
  return line;
}

/** Models whose download this page has finished (or tried to): once per page, never in a loop. */
const finishedOnce = new Set<string>();

function modelCard(
  engine: SharedEngine,
  state: { downloaded: boolean; bytes: number },
  ctx: PanelContext,
): HTMLElement {
  const info = engineInfo(engine);
  const licence =
    engine === 'kokoro' ? ctx.manifest.kokoro.license : engine === 'phonon' ? (ctx.manifest.phonon?.license ?? '') : (ctx.manifest.supertonic?.license ?? '');
  const card = el(document, 'div', { class: `model-card${state.downloaded ? ' is-installed' : ''}` });

  // A machine with a GPU reads with Kokoro's full-precision build — the quantised one returns
  // noise instead of speech on WebGPU — so that is the build its Download fetches, at its size.
  const onGpu = engine === 'kokoro' && readsOnGpu(ctx.settings);
  const size = downloadSize(info, onGpu);
  // Only the CPU build is here (downloaded before, or with the GPU off): reading would fetch the
  // GPU build on its own, so offer it here instead of letting it start on the first preview.
  const gpuMissing = onGpu && state.downloaded && !sharedModelInstalled(engine, ctx.sizes, { gpu: true });
  // The voices' own files come with the model (Kokoro's voice files, Supertonic's styles); one
  // downloaded before they did is missing some of them.
  const voiceList = engine === 'kokoro' ? ctx.manifest.kokoro.voices : engine === 'phonon' ? (ctx.manifest.phonon?.voices ?? {}) : (ctx.manifest.supertonic?.voices ?? {});
  const voices = Object.keys(voiceList);
  const voiceUrl = engine === 'kokoro' ? kokoroVoiceUrl : engine === 'phonon' ? phononVoiceUrl : supertonicStyleUrl;
  const checksums = engine === 'phonon' ? Object.fromEntries(Object.entries(ctx.manifest.phonon?.voices ?? {}).map(([id, v]) => [id, v.sha256])) : {};
  const voicesMissing = state.downloaded ? voices.filter((v) => !ctx.sizes.has(voiceUrl(v))).length : 0;

  const text = el(document, 'div', { class: 'mc-text' });
  text.append(
    el(document, 'b', {}, state.downloaded ? `${info.name} is on this device` : `${info.name} model`),
    licenceLine(`${state.downloaded ? humanBytes(state.bytes) : size} · `, licence, engine === 'phonon' ? ctx.manifest.phonon?.licenseUrl : undefined),
  );
  if (gpuMissing) {
    text.append(el(document, 'span', { class: 'vi-meta' }, `This machine reads with the GPU, which needs Kokoro’s GPU build (${size}). Download it here before you read.`));
  }

  const progress = new RowProgress();
  // The model is here: its card says so and offers to delete it.
  const isDelete = state.downloaded && !gpuMissing;
  const btn = el(
    document,
    'button',
    // Deleting is a quiet link, not a button the shape and place of "Download".
    { class: isDelete ? 'mc-delete' : 'primary', type: 'button' },
    isDelete ? 'Delete from this device' : gpuMissing ? `Download GPU build · ${size}` : `Download ${size}`,
  );

  const key = `model:${engine}`;
  const startDownload = (): void => {
    // Queued behind any download already running; the card says so (followDownload).
    downloads.enqueue(key, `${info.name} model`, (p, signal) =>
      downloadSharedModel(engineConfigFor(ctx.settings, { engine, purpose: 'download' }), voices, p, signal, checksums),
    ).then(
      async () => {
        announceModelsChanged();
        ctx.flashSaved(`${info.name} is ready. Pick a voice below`);
        await ctx.refresh();
      },
      (err: unknown) => {
        if (err instanceof DownloadCancelled) ctx.flashSaved(`${info.name}: download cancelled`);
      },
    );
  };
  // Kokoro is one download, voices included. A model downloaded before its voices came with it is
  // finished here, once, without asking: offering the rest as an extra made one download two.
  const finishing = isDelete && voicesMissing > 0;
  if (finishing && !finishedOnce.has(key)) {
    finishedOnce.add(key);
    startDownload();
  }

  const idle = btn.textContent ?? '';
  btn.addEventListener('click', () => {
    if (!isDelete) {
      startDownload();
      return;
    }
    void runModelAction(btn, async () => {
      try {
        await deleteModels(() => cacheClear(info.cacheHint));
        announceModelsChanged();
        ctx.flashSaved(`${info.name} deleted`);
        await ctx.refresh();
      } catch (err) {
        ctx.flashError(err instanceof Error ? err.message : String(err));
        btn.disabled = false;
      }
    });
  });
  if (!isDelete || finishing) followDownload(key, progress, btn, idle);

  card.append(text, btn, progress.wrap, progress.msg);
  return card;
}
