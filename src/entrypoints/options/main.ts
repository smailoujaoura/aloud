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
import { cacheClear, cacheEntries, cacheUsageBytes } from '@/engine/model-cache';
import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  voiceKeyFor,
  type EngineId,
  type Settings,
  type ThemeChoice,
} from '@/shared/settings';
import { disposePreview, playSynthesized, stopPreview } from '@/ui/voice-preview';
import { clearAllPositions, countPositions } from '@/shared/reading-positions';

/** Say how many pages have a remembered position, so the "forget" button has a visible effect. */
async function refreshPositionsHint(): Promise<void> {
  const n = await countPositions();
  const base = 'Aloud remembers where you stopped on each page and PDF, on this device only, and picks up there next time.';
  $('positionsHint').textContent = n ? `${base} ${n} page${n === 1 ? '' : 's'} remembered.` : base;
  $<HTMLButtonElement>('clearPositions').disabled = n === 0;
}
import { applyTheme, watchSystemTheme, THEME_LABEL } from '@/ui/theme';
import { createThemeSwitch, type ThemeSwitch } from '@/ui/theme-switch';
import type { ModelManifest } from '@/engine/engines/types';

import { piperDownloaded, readCacheSizes, sharedModelBytes, type CacheSizes } from '@/engine/installed-voices';
import { engineInfo } from '@/shared/engine-catalog';
import { engineConfigFor } from './engine-config';
import { renderPronunciationEditor } from './pronunciation-editor';
import { renderVoiceSection, type PanelContext } from './voice-panels';

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
    ? 'Only used when synthesis falls back to the CPU. On the GPU path one worker is enough, and ' +
      'extra workers just add a copy of the model in memory. 0 = auto. Piper ignores this.'
    : 'The neural engines run several times slower than real time on the CPU, so a few sentences ' +
      'are synthesised at once to keep up with playback. 0 = auto, based on your CPU cores. Each ' +
      'extra worker adds one in-memory copy of the model (~90 MB for Kokoro), so higher is not ' +
      'always better. Piper ignores this.';

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

  if (!workerGpu) return 'Checking whether Aloud’s synthesis worker can reach the GPU…';

  if (workerGpu.webgpu) {
    return (
      `Aloud’s synthesis worker has WebGPU here${workerGpu.adapterInfo ? ` (${workerGpu.adapterInfo})` : ''}, ` +
      'so Kokoro and Supertonic run on the GPU — comfortably faster than real time.'
    );
  }

  if (caps.engine === 'gecko') {
    // Firefox *can* do this; it is two prefs away, and saying so is more useful than saying no.
    return page?.available
      ? 'Firefox gives this page a GPU but not its workers, which is where Aloud runs synthesis — ' +
          'so the neural voices are on the CPU. One about:config pref changes that.'
      : 'Firefox keeps WebGPU behind two about:config settings and both are off here, so the ' +
          'neural voices run on the CPU across several workers. Turning them on makes Kokoro ' +
          'faster than Piper on this machine.';
  }

  if (page?.status === 'unsupported') {
    return 'This browser exposes no WebGPU here, so synthesis runs on the CPU across several parallel workers.';
  }

  return (
    'Your browser has WebGPU but this machine granted no GPU adapter, so synthesis runs on the ' +
    'CPU across several parallel workers. Check chrome://gpu — on Linux, WebGPU needs a ' +
    'Vulkan-capable driver and Chrome 137 or newer; chrome://flags/#enable-unsafe-webgpu can ' +
    'force it on a machine Chrome has blocklisted.'
  );
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
  const summary = workerGpu.webgpu
    ? 'GPU found for the synthesis worker.'
    : workerGpu.detail;
  $('gpuChecked').textContent = summary;
  await render();
  // Returned so the button that asked can say what came back. Without this the check ran, found
  // the same answer as before, changed no visible text, and looked like a dead button.
  return summary;
}

async function render(): Promise<void> {
  settings = await getSettings();
  applyTheme(document, settings.theme);
  for (const control of themeSwitches) control.setTheme(settings.theme);
  const manifest = await loadManifest();
  const sizes = await readCacheSizes();

  $<HTMLInputElement>('speed').value = String(settings.speed);
  $('speedOut').textContent = `${settings.speed.toFixed(2)}×`;
  $<HTMLInputElement>('highlight').checked = settings.highlight;
  $<HTMLInputElement>('highlightColor').value = toHex(settings.highlightColor);
  $<HTMLSelectElement>('scrollMode').value = settings.scrollMode;
  $<HTMLSelectElement>('pdfView').value = settings.pdfView;
  $<HTMLInputElement>('sectionPauseMs').value = String(settings.sectionPauseMs);
  $('sectionPauseOut').textContent = `${(settings.sectionPauseMs / 1000).toFixed(2)}s`;
  $<HTMLInputElement>('sentencePauseMs').value = String(settings.sentencePauseMs);
  $('sentencePauseOut').textContent = `${(settings.sentencePauseMs / 1000).toFixed(2)}s`;
  $<HTMLInputElement>('tapToSeek').checked = settings.tapToSeek;
  $<HTMLInputElement>('skipUrls').checked = settings.skipUrls;
  $<HTMLInputElement>('expandAbbreviations').checked = settings.expandAbbreviations;

  $<HTMLSelectElement>('kokoroDtype').value = settings.kokoroDtype;
  $<HTMLInputElement>('supertonicSteps').value = String(settings.supertonicSteps);
  $('supertonicStepsOut').textContent = String(settings.supertonicSteps);
  $<HTMLInputElement>('synthWorkers').value = String(settings.synthWorkers);
  $('synthWorkersOut').textContent = settings.synthWorkers === 0 ? 'auto' : String(settings.synthWorkers);
  $<HTMLInputElement>('preferWebGPU').checked = settings.preferWebGPU;
  $<HTMLInputElement>('debug').checked = settings.debug;
  $('kokoro-dtype-row').hidden = settings.engine !== 'kokoro';
  $('supertonic-steps-row').hidden = settings.engine !== 'supertonic';

  renderCapabilityHints();

  const ctx: PanelContext = {
    settings,
    manifest,
    sizes,
    filter: $<HTMLInputElement>('voiceFilter').value.trim().toLowerCase(),
    refresh: render,
    useVoice,
    flashSaved,
  };
  renderVoiceSection({ nowReading: $('nowReading'), tabs: $('engineTabs'), panel: $('enginePanels') }, ctx);

  void refreshUsage();
  void refreshPositionsHint();

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

/** Is the voice that reads to you actually on this device? */
function currentVoiceInstalled(manifest: ModelManifest, sizes: CacheSizes): boolean {
  if (settings.engine === 'piper') {
    const entry = manifest.piper[settings.piperVoice];
    return entry ? piperDownloaded(entry, sizes) : false;
  }
  return sharedModelBytes(sizes, engineInfo(settings.engine).cacheHint ?? '') > 0;
}

function wire(): void {
  renderPrefList();

  wireSlider('speed', 'speedOut', 'speed', (v) => `${v.toFixed(2)}×`);
  wireSlider('sectionPauseMs', 'sectionPauseOut', 'sectionPauseMs', (v) => `${(v / 1000).toFixed(2)}s`);
  wireSlider('sentencePauseMs', 'sentencePauseOut', 'sentencePauseMs', (v) => `${(v / 1000).toFixed(2)}s`);
  wireSlider('supertonicSteps', 'supertonicStepsOut', 'supertonicSteps', String);
  wireSlider('synthWorkers', 'synthWorkersOut', 'synthWorkers', (v) => (v === 0 ? 'auto' : String(v)));

  wireCheckbox('highlight', 'highlight');
  wireCheckbox('tapToSeek', 'tapToSeek');
  wireCheckbox('skipUrls', 'skipUrls');
  wireCheckbox('expandAbbreviations', 'expandAbbreviations');
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
  $('kokoroDtype').addEventListener('change', async (e) => {
    await save({ kokoroDtype: (e.target as HTMLSelectElement).value as Settings['kokoroDtype'] });
    await render();
  });

  let filterTimer = 0;
  $('voiceFilter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => void render(), 180);
  });

  $('clearModels').addEventListener('click', (e) => {
    if (!confirm('Delete every cached model file? They will re-download next time.')) return;
    stopPreview();
    void withBusy(
      e.currentTarget as HTMLButtonElement,
      'Deleting…',
      async () => {
        await cacheClear();
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

  for (const id of ['walkthrough', 'walkthroughFooter']) {
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
  const remembered = await loadWorkerGpu();
  if (remembered != null) applyWorkerGpuProbe(remembered);
  await probeGpu()
    .then((probe) => {
      // A page probe may only narrow: on Gecko it says nothing about workers at all.
      if (!probe.available && capabilities().engine !== 'gecko') applyGpuProbe(probe);
    })
    .catch(() => undefined);
  await render();
  await checkWorkerGpu();
})();
