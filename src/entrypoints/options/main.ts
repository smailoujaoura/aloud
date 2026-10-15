/**
 * Options page controller.
 *
 * Deliberately thin: it owns the settings object and the redraw cycle, and delegates everything
 * with structure to a neighbouring module — `voice-panels` for the whole Voice section,
 * `preview-button` for previews, `downloads` for transfer plumbing, `engine/installed-voices` for
 * reading the cache. Rendering is whole-page and idempotent: every change saves, then redraws from
 * storage, so the page can never show state that disagrees with what was saved.
 */
import { browser } from 'wxt/browser';

import { el } from '@/shared/dom';
import { humanBytes, log } from '@/shared/log';
import { applyGpuProbe, applyWorkerGpuProbe, capabilities } from '@/shared/browser-env';
import { probeGpu, gpuProbeIfKnown } from '@/shared/gpu-probe';
import { loadWorkerGpu } from '@/shared/backend-memory';
import { probeWorkerGpu, type WorkerGpuResult } from './gpu-check';
import { listVoices } from '@/shared/voice-catalog';
import { languageName } from '@/shared/language-voice';
import { OTHER_LANGUAGES } from './voice-board';
import { cacheClear, cacheEntries, cacheUsageBytes, deleteModels } from '@/engine/model-cache';
import {
  DEFAULT_SETTINGS,
  getSettings,
  watchSettings,
  setSettings,
  voiceKeyFor,
  type EngineId,
  type Settings,
  type ThemeChoice,
} from '@/shared/settings';
import { disposePreview, playSynthesized, stopPreview } from '@/ui/voice-preview';
import { speedLabel } from '@/shared/reading-rate';
import { clearAllPositions, countPositions } from '@/shared/reading-positions';

/** Say how many pages have a remembered position, so the "forget" button has a visible effect. */
async function refreshPositionsHint(): Promise<void> {
  const n = await countPositions();
  $('positionsHint').textContent = n ? `${n} page${n === 1 ? '' : 's'} remembered` : 'None remembered';
  $<HTMLButtonElement>('clearPositions').disabled = n === 0;
}
import { applyTheme, watchSystemTheme, THEME_LABEL } from '@/ui/theme';
import { createThemeSwitch, type ThemeSwitch } from '@/ui/theme-switch';
import type { ModelManifest } from '@/engine/engines/types';

import { piperDownloaded, readCacheSizes, sharedModelBytes, sharedModelInstalled, type CacheSizes } from '@/engine/installed-voices';
import { engineInfo } from '@/shared/engine-catalog';
import { engineConfigFor } from './engine-config';
import { renderMediaSpeedPanel } from './media-speed-panel';
import { renderNoteStylePanel } from './note-style-panel';
import { renderBackupPanel } from './backup-panel';
import { renderShortcutsPanel } from './shortcuts-panel';
import { renderSiteList } from './site-list';
import { renderPronunciationEditor } from './pronunciation-editor';
import { renderVoiceSection, type PanelContext } from './voice-panels';
import { initNav, onViewChange, setNavCount, showView } from './app-nav';
import { initLibrary } from '@/library/app';
import { answerTabQueries } from '@/shared/own-tab';
import { downloads } from './download-queue';
import { announceModelsChanged, onModelsChanged } from './downloads';

// First, before anything here can fail: lets the background find this tab without the "tabs"
// permission (shared/own-tab.ts). Registered late, an earlier error meant a new tab every time.
answerTabQueries();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings;
let manifestCache: ModelManifest | null = null;

async function loadManifest(): Promise<ModelManifest> {
  if (manifestCache) return manifestCache;
  const res = await fetch(browser.runtime.getURL('/models.json'));
  manifestCache = (await res.json()) as ModelManifest;
  return manifestCache;
}

// ---- saving & feedback -----------------------------------------------------

/**
 * The page's single channel for "here is what just happened".
 *
 * Settings here save on change rather than behind an Apply button, which is only trustworthy if
 * every save says so — otherwise a click that changes a number nobody can see is
 * indistinguishable from a click that did nothing. `spinner` holds the message open for work
 * that is still running; everything else fades.
 */
let toastTimer = 0;
function toast(text: string, kind: 'info' | 'ok' | 'error' = 'info', spinner = false): void {
  const box = $('toast');
  box.className = kind === 'info' ? 'toast' : `toast ${kind}`;
  box.replaceChildren(
    ...(spinner ? [el(document, 'span', { class: 'spinner' })] : []),
    document.createTextNode(text),
  );
  box.hidden = false;
  clearTimeout(toastTimer);
  if (!spinner) toastTimer = window.setTimeout(() => (box.hidden = true), 2200);
}

function flashSaved(message = 'Saved'): void {
  toast(message, 'ok');
}

/**
 * Run a button's action with the button itself reporting the wait.
 *
 * Deleting a cache or resetting every setting takes long enough to look broken. The button keeps
 * its width (`min-width` from its resting size) so nothing around it moves, says what it is
 * doing, and refuses a second click until it is finished.
 */
async function withBusy(
  button: HTMLButtonElement,
  busyLabel: string,
  /** Returning a string reports *that* instead of `doneMessage` — for work whose outcome varies. */
  action: () => Promise<void | string>,
  doneMessage?: string,
): Promise<void> {
  if (button.disabled) return;
  const label = button.textContent ?? '';
  button.style.minWidth = `${button.getBoundingClientRect().width}px`;
  button.disabled = true;
  button.classList.add('busy');
  button.textContent = busyLabel;
  toast(busyLabel, 'info', true);
  try {
    const reported = await action();
    const done = typeof reported === 'string' ? reported : doneMessage;
    if (done) toast(done, 'ok');
    else $('toast').hidden = true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = label;
  }
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await setSettings(patch);
  flashSaved();
}

/** Switch engine and/or voice from anywhere on the page, then redraw. */
/**
 * Choose who reads `language` — the one way a voice is chosen on the Voice page, the same for every
 * language, English included. `OTHER_LANGUAGES` is every language without a voice of its own.
 */
async function chooseVoice(language: string, engine: EngineId, voiceId: string): Promise<void> {
  stopPreview();
  if (language === OTHER_LANGUAGES) {
    settings = await setSettings({ otherVoice: { engine, voice: voiceId }, unvoicedLanguages: 'english' });
    await render();
    flashSaved(`Every other language is read by ${voiceLabel(engine, voiceId)}`);
    return;
  }
  settings = await setSettings({
    languageVoices: { ...settings.languageVoices, [language]: { engine, voice: voiceId } },
    removedLanguages: settings.removedLanguages.filter((l) => l !== language),
  });
  await render();
  flashSaved(`${languageName(language)} is read by ${voiceLabel(engine, voiceId)}`);
}

async function useVoice(engine: EngineId, voiceId: string): Promise<void> {
  stopPreview();
  const name = voiceLabel(engine, voiceId);
  toast(`Switching to ${name}…`, 'info', true);
  settings = await setSettings({ engine, [voiceKeyFor(engine)]: voiceId });
  await render();
  // Named, and told what happens next: the voice is not on this device until something fetches
  // it, and "saved" alone would leave that surprise for the next page they read.
  toast(`${name} is now your voice`, 'ok');
}

/** A voice's human name, for messages. Falls back to the id when the manifest has no entry. */
function voiceLabel(engine: EngineId, voiceId: string): string {
  if (!manifestCache) return voiceId;
  return listVoices(engine, manifestCache).find((v) => v.id === voiceId)?.label ?? voiceId;
}

// ---- render ----------------------------------------------------------------

/** `rgba(r, g, b, a)` -> `#rrggbb`, for the native colour input. */
function toHex(color: string): string {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return color.startsWith('#') ? color : '#ffd60a';
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

async function refreshUsage(): Promise<void> {
  const [bytes, entries] = await Promise.all([cacheUsageBytes(), cacheEntries()]);
  // `bytes` also counts the Cache API stores our dependencies write to (Kokoro's voice
  // vectors), which have no entry in our own store — so report the count separately rather than
  // implying every byte belongs to one of those files.
  $('usage').textContent = entries.length
    ? `${humanBytes(bytes)} on this device, including ${entries.length} model file(s).`
    : 'No models cached yet.';
}

/**
 * Copy that describes *this machine*, not this browser.
 *
 * The line users act on is the GPU one, so it has to be true. Two probes feed it and they are
 * not interchangeable: `gpu-probe.ts` measures *this page*, while `gpu-check.ts` spawns a real
 * synthesis worker and asks it. Only the second one answers the question that matters, because
 * Firefox gates documents (`dom.webgpu.enabled`) and workers (`dom.webgpu.workers.enabled`)
 * separately — a page with WebGPU can host workers without it, and vice versa.
 */

/** The worker-side answer once it is in; `null` while the check is still running. */
let workerGpu: WorkerGpuResult | null = null;

function renderCapabilityHints(): void {
  const caps = capabilities();

  $('workersHint').textContent = caps.workerWebGPU
    ? 'Only used on the processor. Auto is best.'
    : 'More workers keep Kokoro ahead on the processor, at ~90 MB of memory each. Auto is best.';

  $('webgpuHint').textContent = gpuHintText();
  $('webgpuHint').classList.toggle('warn', workerGpu != null && !workerGpu.webgpu && caps.engine === 'gecko');

  // The Firefox recipe is only useful to a Firefox user who does not have it working yet. It is
  // built once at wiring time and merely shown or hidden here, so what it says never depends on
  // the order the two probes happened to finish in.
  $('firefoxGpu').hidden = !(caps.engine === 'gecko' && workerGpu != null && !workerGpu.webgpu);
}

/** One sentence about the GPU, and what — if anything — would change it. */
function gpuHintText(): string {
  const caps = capabilities();
  const page = gpuProbeIfKnown();

  if (!workerGpu) return 'Checking for a graphics card…';

  if (workerGpu.webgpu) {
    return `Voices run on your graphics card${workerGpu.adapterInfo ? ` (${workerGpu.adapterInfo})` : ''}.`;
  }

  if (caps.engine === 'gecko') {
    // Firefox *can* do this; it is two prefs away, and saying so is more useful than saying no.
    return page?.available
      ? 'Voices run on the processor: Firefox gives the graphics card to pages but not to Aloud’s worker.'
      : 'Voices run on the processor: Firefox keeps WebGPU switched off.';
  }

  if (page?.status === 'unsupported') return 'Voices run on the processor: this browser has no WebGPU.';

  return 'Voices run on the processor: the browser found no usable graphics card. Check chrome://gpu.';
}

/** The three prefs, each with a button that copies its name — they are tedious to retype. */
const FIREFOX_PREFS: Array<{ name: string; value: string; why: string }> = [
  { name: 'dom.webgpu.enabled', value: 'true', why: 'turns WebGPU on at all' },
  {
    name: 'dom.webgpu.workers.enabled',
    value: 'true',
    why: 'the one that matters here — it lets web workers use it, and synthesis runs in a worker',
  },
  {
    name: 'gfx.webrender.all',
    value: 'true',
    why: 'forces GPU rendering; only needed if hardware acceleration is off on your machine',
  },
];

function renderPrefList(): void {
  const list = $('prefList');
  list.replaceChildren(
    el(document, 'li', {}, 'Open a new tab, go to about:config and accept the warning.'),
    ...FIREFOX_PREFS.map((pref) => {
      const li = el(document, 'li');
      const code = el(document, 'code', {}, pref.name);
      const copy = el(document, 'button', { class: 'copy-btn', type: 'button' }, 'Copy');
      copy.addEventListener('click', () => void copyPref(pref.name, copy));
      li.append(
        document.createTextNode('Search for '),
        code,
        copy,
        el(document, 'div', { class: 'muted small' }, `Set it to ${pref.value} — ${pref.why}.`),
      );
      return li;
    }),
  );
}

async function copyPref(name: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(name);
    const label = button.textContent ?? 'Copy';
    button.textContent = 'Copied';
    toast(`Copied ${name}`, 'ok');
    setTimeout(() => (button.textContent = label), 1200);
  } catch {
    toast('Could not copy — select the name and copy it by hand', 'error');
  }
}

/**
 * Ask a real synthesis worker whether it has a GPU, and repaint everything that depends on the
 * answer: the hint, the engine standings and blurbs, the walkthrough's cards (through the
 * remembered value), and the worker-count advice.
 */
async function checkWorkerGpu(): Promise<string> {
  workerGpu = await probeWorkerGpu();
  // Logged, not just rendered: "is the GPU actually being used" is the first question behind
  // every "why is this slow", and a line in the console is what makes it answerable from a bug
  // report rather than from guesswork.
  log.info(`worker GPU check: webgpu=${workerGpu.webgpu} — ${workerGpu.detail}`);
  applyWorkerGpuProbe(workerGpu.webgpu);
  const summary = workerGpu.webgpu ? 'Graphics card found' : 'No graphics card for the voice';
  // The line above the button already says what this means; the technical detail is a hover away.
  $('gpuChecked').textContent = 'Checked just now';
  $('gpuChecked').title = workerGpu.detail;
  await render();
  // Returned so the button that asked can say what came back. Without this the check ran, found
  // the same answer as before, changed no visible text, and looked like a dead button.
  return summary;
}

/** The speed panel's options, rebuilt after each save so its chips and keys show the new state. */
let backupRendered = false;

function renderNoteStyle(): void {
  renderNoteStylePanel($('noteStyle'), {
    settings: settings.annotate,
    save: async (patch) => {
      settings = await setSettings({ annotate: { ...settings.annotate, ...patch } });
      flashSaved();
      renderNoteStyle();
    },
  });
}

function mediaSpeedOptions(): Parameters<typeof renderMediaSpeedPanel>[1] {
  return {
    settings: settings.mediaSpeed,
    save: async (patch) => {
      settings = await setSettings({ mediaSpeed: { ...settings.mediaSpeed, ...patch } });
      flashSaved();
      renderMediaSpeedPanel($('mediaSpeed'), mediaSpeedOptions());
    },
    toast: (message: string) => flashSaved(message),
  };
}

/** "Show my highlights by themselves on" — the sites list for page highlights. */
function renderAnnotateSites(): void {
  renderSiteList($('annotateSites'), {
    heading: 'Show my highlights by themselves on',
    empty: 'No sites yet — highlights appear when you use Aloud on a page or open a note.',
    what: 'your highlights',
    sites: settings.annotate.alwaysOn,
    save: async (alwaysOn) => {
      settings = await setSettings({ annotate: { ...settings.annotate, alwaysOn } });
      flashSaved();
      renderAnnotateSites();
    },
    toast: (message) => flashSaved(message),
  });
}

/**
 * The thread of colour at the top of the window while the page is working.
 *
 * Counted rather than toggled: two overlapping pieces of work (the GPU probe and a redraw) would
 * otherwise have the first one to finish declare the page idle.
 */
let busyCount = 0;
export function setBusy(on: boolean): void {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const bar = document.getElementById('pageBusy');
  if (bar) bar.hidden = busyCount === 0;
}

async function render(): Promise<void> {
  setBusy(true);
  try {
    await renderNow();
  } finally {
    setBusy(false);
  }
}

async function renderNow(): Promise<void> {
  settings = await getSettings();
  applyTheme(document, settings.theme);
  for (const control of themeSwitches) control.setTheme(settings.theme);
  const manifest = await loadManifest();
  const sizes = await readCacheSizes();

  $<HTMLInputElement>('speed').value = String(settings.speed);
  $('speedOut').textContent = speedLabel(settings.speed);
  $<HTMLInputElement>('highlight').checked = settings.highlight;
  $<HTMLSelectElement>('wordHighlight').value = settings.wordHighlight;
  $<HTMLInputElement>('highlightReadable').checked = settings.highlightReadable;
  $<HTMLSelectElement>('wordHighlight').disabled = !settings.highlight;
  $<HTMLInputElement>('highlightColor').value = toHex(settings.highlightColor);
  $<HTMLSelectElement>('scrollMode').value = settings.scrollMode;
  $<HTMLSelectElement>('pdfView').value = settings.pdfView;
  $<HTMLInputElement>('sectionPauseMs').value = String(settings.sectionPauseMs);
  $('sectionPauseOut').textContent = `${(settings.sectionPauseMs / 1000).toFixed(2)}s`;
  $<HTMLInputElement>('sentencePauseMs').value = String(settings.sentencePauseMs);
  $('sentencePauseOut').textContent = `${(settings.sentencePauseMs / 1000).toFixed(2)}s`;
  $<HTMLInputElement>('tapToSeek').checked = settings.tapToSeek;
  $<HTMLInputElement>('barAutoHide').checked = settings.barAutoHide;

  $<HTMLInputElement>('skipUrls').checked = settings.skipUrls;
  $<HTMLInputElement>('expandAbbreviations').checked = settings.expandAbbreviations;
  for (const [id, key] of SKIP_SWITCHES) $<HTMLInputElement>(id).checked = settings.skip[key];

  $<HTMLInputElement>('supertonicSteps').value = String(settings.supertonicSteps);
  $('supertonicStepsOut').textContent = String(settings.supertonicSteps);
  $<HTMLInputElement>('synthWorkers').value = String(settings.synthWorkers);
  $('synthWorkersOut').textContent = settings.synthWorkers === 0 ? 'auto' : String(settings.synthWorkers);
  $<HTMLInputElement>('preferWebGPU').checked = settings.preferWebGPU;
  $<HTMLInputElement>('debug').checked = settings.debug;
  $('supertonic-steps-row').hidden = settings.engine !== 'supertonic';

  renderCapabilityHints();

  const ctx: PanelContext = {
    settings,
    manifest,
    sizes,
    filter: $<HTMLInputElement>('voiceFilter').value.trim().toLowerCase(),
    refresh: render,
    useVoice,
    chooseVoice,
    flashSaved,
    flashError: (message: string) => toast(message, 'error'),
    setLanguageVoice: async (language, voice) => {
      const next = { ...settings.languageVoices };
      if (voice) next[language] = voice;
      else delete next[language];
      settings = await setSettings({ languageVoices: next });
      await render();
      flashSaved(voice ? `${languageName(language)} will be read by ${voiceLabel(voice.engine, voice.voice)}` : `${languageName(language)}: automatic`);
    },
    setLanguageRemoved: async (language, removed) => {
      const rest = settings.removedLanguages.filter((l) => l !== language);
      settings = await setSettings({ removedLanguages: removed ? [...rest, language] : rest });
      await render();
      flashSaved(removed ? `${languageName(language)} is read like every other language` : `${languageName(language)} has its own voices again`);
    },
    setOtherVoice: async (voice) => {
      settings = await setSettings({ otherVoice: voice, unvoicedLanguages: 'english' });
      await render();
      flashSaved('Every other language: automatic');
    },
    setUnvoiced: async (choice) => {
      settings = await setSettings({ unvoicedLanguages: choice });
      await render();
      flashSaved(choice === 'skip' ? 'Languages without a voice are skipped' : 'Languages without a voice are read in English');
    },
    setAutoLanguage: async (on) => {
      settings = await setSettings({ matchPageLanguage: on });
      await render();
      flashSaved(on ? 'Voices switch with the language' : 'One voice for every language');
    },
  };
  renderVoiceSection(
    {
      board: $('voiceBoard'),
      catalogue: $('voiceCatalogue'),
      tabs: $('engineTabs'),
      panel: $('enginePanels'),
    },
    ctx,
  );

  void refreshUsage();
  void refreshPositionsHint();

  $<HTMLInputElement>('mediaSpeedEnabled').checked = settings.mediaSpeed.enabled;
  renderMediaSpeedPanel($('mediaSpeed'), mediaSpeedOptions());
  renderNoteStyle();
  void renderShortcutsPanel($('shortcuts'), {
    toast: (message, kind) => toast(message, kind ?? 'info'),
    pageKeys: settings.annotate.pageKeys,
    savePageKeys: async (pageKeys) => {
      settings = await setSettings({ annotate: { ...settings.annotate, pageKeys } });
      flashSaved();
    },
  });
  if (!backupRendered) {
    // Drawn once: a restore in progress keeps its steps while the rest of the page redraws.
    backupRendered = true;
    renderBackupPanel($('backup'), {
      manifest,
      toast: (message, kind) => toast(message, kind ?? 'info'),
      onRestored: async () => {
        settings = await getSettings();
        await render();
      },
    });
  }

  renderPronunciationEditor($('pronunciations'), {
    rules: settings.pronunciations,
    save: async (rules) => {
      settings = await setSettings({ pronunciations: rules.map((r) => ({ ...r })) });
      flashSaved('Pronunciation saved');
    },
    speak: (text, onStatus) =>
      playSynthesized(engineConfigFor(settings, { purpose: 'preview' }), onStatus, text),
    speakDisabledReason: currentVoiceInstalled(manifest, sizes)
      ? undefined
      : 'Download your current voice first to hear fixes in it',
  });
}

// ---- theme -----------------------------------------------------------------

/**
 * The theme control, mounted once in the Appearance section.
 *
 * It was briefly mounted twice — here and in the page header — which just read as the same
 * setting offered twice. Kept as a list because the walkthrough mounts the same control, and
 * because a reset has to move whichever ones exist.
 */
const themeSwitches: ThemeSwitch[] = [];

function mountThemeSwitches(): void {
  const control = createThemeSwitch(document, settings.theme, (choice) => void chooseTheme(choice));
  themeSwitches.push(control);
  $('themeSwitchRow').replaceChildren(control.root);
}

async function chooseTheme(choice: ThemeChoice): Promise<void> {
  applyTheme(document, choice);
  for (const control of themeSwitches) control.setTheme(choice);
  settings = await setSettings({ theme: choice });
  // Named rather than "Saved": the page has already repainted, and the message's job is to say
  // that the reading bar and the PDF reader just changed too.
  toast(`Theme: ${THEME_LABEL[choice].toLowerCase()} — applied everywhere Aloud draws`, 'ok');
}

// ---- wiring ----------------------------------------------------------------

/** A range input that shows its value live and saves on release. */
function wireSlider(
  id: string,
  outId: string,
  key: keyof Settings,
  format: (value: number) => string,
): void {
  $(id).addEventListener('input', (e) => {
    $(outId).textContent = format(Number((e.target as HTMLInputElement).value));
  });
  $(id).addEventListener('change', (e) => save({ [key]: Number((e.target as HTMLInputElement).value) }));
}

function wireCheckbox(id: string, key: keyof Settings): void {
  $(id).addEventListener('change', (e) => save({ [key]: (e.target as HTMLInputElement).checked }));
}

/** The skip switches and the part of `settings.skip` each one controls. */
const SKIP_SWITCHES: Array<[string, keyof Settings['skip']]> = [
  ['skipCode', 'code'],
  ['skipTables', 'tables'],
  ['skipCaptions', 'captions'],
  ['skipReferences', 'references'],
];

/** Is the voice that reads to you actually on this device? */
function currentVoiceInstalled(manifest: ModelManifest, sizes: CacheSizes): boolean {
  if (settings.engine === 'piper') {
    const entry = manifest.piper[settings.piperVoice];
    return entry ? piperDownloaded(entry, sizes) : false;
  }
  return sharedModelInstalled(settings.engine, sizes);
}

function wire(): void {
  renderPrefList();

  wireSlider('speed', 'speedOut', 'speed', speedLabel);
  wireSlider('sectionPauseMs', 'sectionPauseOut', 'sectionPauseMs', (v) => `${(v / 1000).toFixed(2)}s`);
  wireSlider('sentencePauseMs', 'sentencePauseOut', 'sentencePauseMs', (v) => `${(v / 1000).toFixed(2)}s`);
  wireSlider('supertonicSteps', 'supertonicStepsOut', 'supertonicSteps', String);
  wireSlider('synthWorkers', 'synthWorkersOut', 'synthWorkers', (v) => (v === 0 ? 'auto' : String(v)));

  $('annotateToolbar').addEventListener('change', async (e) => {
    const toolbar = (e.target as HTMLInputElement).checked;
    settings = await setSettings({ annotate: { ...settings.annotate, toolbar } });
    flashSaved();
  });

  $('mediaSpeedEnabled').addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    settings = await setSettings({ mediaSpeed: { ...settings.mediaSpeed, enabled } });
    flashSaved(enabled ? 'Speed control on' : 'Speed control off');
    renderMediaSpeedPanel($('mediaSpeed'), mediaSpeedOptions());
    $('mediaSpeed').classList.toggle('is-off', !enabled);
  });

  wireCheckbox('highlight', 'highlight');
  wireCheckbox('highlightReadable', 'highlightReadable');
  $('wordHighlight').addEventListener('change', (e) =>
    save({ wordHighlight: (e.target as HTMLSelectElement).value as Settings['wordHighlight'] }),
  );
  wireCheckbox('tapToSeek', 'tapToSeek');
  wireCheckbox('barAutoHide', 'barAutoHide');
  wireCheckbox('skipUrls', 'skipUrls');
  wireCheckbox('expandAbbreviations', 'expandAbbreviations');
  for (const [id, key] of SKIP_SWITCHES) {
    $(id).addEventListener('change', (e) =>
      save({ skip: { ...settings.skip, [key]: (e.target as HTMLInputElement).checked } }),
    );
  }
  wireCheckbox('preferWebGPU', 'preferWebGPU');
  wireCheckbox('debug', 'debug');

  $('highlightColor').addEventListener('change', (e) => {
    const hex = (e.target as HTMLInputElement).value;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    void save({ highlightColor: `rgba(${r}, ${g}, ${b}, 0.45)` });
  });
  $('pdfView').addEventListener('change', (e) =>
    save({ pdfView: (e.target as HTMLSelectElement).value as Settings['pdfView'] }),
  );
  $('scrollMode').addEventListener('change', (e) =>
    save({ scrollMode: (e.target as HTMLSelectElement).value as Settings['scrollMode'] }),
  );

  let filterTimer = 0;
  $('voiceFilter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void render(), 180);
  });

  // Another settings tab downloaded or deleted a model: show the cache as it is now.
  onModelsChanged(() => void render());

  $('clearModels').addEventListener('click', (e) => {
    // Not under a download: it would delete what is being written, and the download would then
    // finish into an empty cache. Say why instead of doing nothing.
    if (downloads.busy) {
      toast('Some voices are still downloading — wait for them to finish, or cancel the ones waiting, then delete.', 'error');
      return;
    }
    if (!confirm('Delete every cached model file? They will re-download next time.')) return;
    stopPreview();
    void withBusy(
      e.currentTarget as HTMLButtonElement,
      'Deleting…',
      async () => {
        // Only with nothing downloading or loading anywhere — another settings tab, a page being
        // read (deleteModels). Otherwise it says so, rather than report a deletion that a
        // download then undoes.
        await deleteModels(() => cacheClear());
        announceModelsChanged();
        await render();
      },
      'Every cached model file has been deleted',
    );
  });
  $('clearPositions').addEventListener('click', (e) => {
    void withBusy(
      e.currentTarget as HTMLButtonElement,
      'Forgetting…',
      async () => {
        await clearAllPositions();
        await refreshPositionsHint();
      },
      'Every page will start from the top again',
    );
  });
  $('openPdf').addEventListener('click', (e) => {
    // No `src`: the reader page opens straight into its picker, which needs no permission on
    // any browser. This is the entry point for "read this file I have on disk".
    void withBusy(
      e.currentTarget as HTMLButtonElement,
      'Opening…',
      () => Promise.resolve(browser.tabs.create({ url: browser.runtime.getURL('/pdf.html') })).then(
        () => undefined,
      ),
      'Opened the PDF reader in a new tab',
    );
  });

  $('reset').addEventListener('click', (e) => {
    if (!confirm('Put every setting back to its default? Downloaded voices are kept.')) return;
    void withBusy(
      e.currentTarget as HTMLButtonElement,
      'Restoring…',
      async () => {
        // The theme is a setting like any other, so a reset moves it — and the page has to
        // follow immediately rather than waiting for the next load.
        await setSettings(DEFAULT_SETTINGS);
        await render();
        applyTheme(document, DEFAULT_SETTINGS.theme);
        for (const control of themeSwitches) control.setTheme(DEFAULT_SETTINGS.theme);
      },
      'Every setting is back to its default',
    );
  });

  $('gpuRecheck').addEventListener('click', (e) =>
    void withBusy(
      e.currentTarget as HTMLButtonElement,
      'Checking…',
      () => checkWorkerGpu(),
      undefined,
    ),
  );

  for (const id of ['walkthrough']) {
    $(id).addEventListener('click', () => {
      toast('Opening the walkthrough…', 'info');
      void browser.runtime.sendMessage({ type: 'open-walkthrough' }).catch(() => undefined);
    });
  }

  window.addEventListener('pagehide', disposePreview);
}

wire();
// The theme has to be right before anything else is: repainting the page a moment after it
// appears is exactly the flash the `data-theme` stamp exists to avoid.
void getSettings().then((s) => {
  settings = s;
  applyTheme(document, s.theme);
  mountThemeSwitches();
  watchSystemTheme(() => {
    if (settings?.theme === 'system') applyTheme(document, 'system');
  });
});

// Describe what this machine actually does, in three steps of increasing authority:
//   1. what a previous run of the synthesis worker found (remembered, instant);
//   2. a page-side probe, which can only take a GPU away (Chromium grants `navigator.gpu`
//      everywhere, including machines where `requestAdapter()` returns null);
//   3. a live probe inside a real synthesis worker, which is the answer — and the only one that
//      catches a Firefox user who has just switched the about:config prefs on.
void (async () => {
  setBusy(true);
  const remembered = await loadWorkerGpu();
  if (remembered != null) applyWorkerGpuProbe(remembered);
  await probeGpu()
    .then((probe) => {
      // A page probe may only narrow: on Gecko it says nothing about workers at all.
      if (!probe.available && capabilities().engine !== 'gecko') applyGpuProbe(probe);
    })
    .catch(() => undefined);
  setBusy(false);
  await render();
  await checkWorkerGpu();
})();

/**
 * The toolbar button was pressed on a page no extension may read — the new tab page, the
 * browser's own settings, an add-on store, a local file without access — and the background
 * opened this page instead (`#cant-read-page` / `#cant-read-file`). Say so, once, and offer the
 * places Aloud can read from.
 */
function explainUnreadablePage(): void {
  const match = /^#cant-read-(page|file)$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, '', location.pathname);
  const gecko = navigator.userAgent.includes('Firefox');
  $('cantReadText').textContent =
    match[1] === 'file'
      ? gecko
        ? 'Firefox doesn’t let add-ons read files on your disk. Open a PDF from here instead, or open the page from a website.'
        : 'Aloud isn’t allowed to read local files yet. Turn on “Allow access to file URLs” for Aloud on chrome://extensions, or open a PDF from here.'
      : 'Browsers keep extensions out of their own pages — new tabs, settings, add-on stores. Open an article or a PDF and press the Aloud button there. Meanwhile, here are your settings.';
  $('cantRead').hidden = false;
  $('cantReadClose').addEventListener('click', () => ($('cantRead').hidden = true));
  $('cantReadLibrary').addEventListener('click', () => showView('continue', { push: true }));
  $('cantReadPdf').addEventListener('click', () => $<HTMLButtonElement>('openPdf').click());
}

explainUnreadablePage();

// Settings changed somewhere else — another Aloud tab, the reading bar's voice menu, a restored
// backup — are shown here too. Changes made on this page are already on it: only a page that is
// not the one being used redraws, so nothing moves under the cursor.
watchSettings((next) => {
  if (document.hasFocus() || !settings) return;
  settings = next;
  void render();
});
// The rail says what the view in front of you is for (rail.ts).
initNav();
void initLibrary({ show: (view) => showView(view, { push: true }), setCount: setNavCount });
