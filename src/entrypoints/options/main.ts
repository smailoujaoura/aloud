/**
 * Options page controller.
 *
 * Deliberately thin: it owns the settings object and the redraw cycle, and delegates everything
 * with structure to a neighbouring module — `voice-panels` for the downloads section,
 * `preview-button` for previews, `downloads` for transfer plumbing, `model-status` for reading
 * the cache. Rendering is whole-page and idempotent: every change saves, then redraws from
 * storage, so the page can never show state that disagrees with what was saved.
 */
import { browser } from 'wxt/browser';

import { el } from '@/shared/dom';
import { humanBytes } from '@/shared/log';
import { capabilities } from '@/shared/browser-env';
import { engineInfo, rankedEngines } from '@/shared/engine-catalog';
import { groupByLanguage } from '@/shared/voice-catalog';
import { cacheClear, cacheEntries, cacheUsageBytes } from '@/engine/model-cache';
import {
  DEFAULT_SETTINGS,
  activeVoice,
  getSettings,
  setSettings,
  voiceKeyFor,
  type EngineId,
  type Settings,
} from '@/shared/settings';
import { disposePreview, stopPreview } from '@/ui/voice-preview';
import type { ModelManifest } from '@/engine/engines/types';

import { readCacheSizes, usableVoices, type CacheSizes } from './model-status';
import { previewFor } from './preview-button';
import { renderEnginePanels, type PanelContext } from './voice-panels';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings;
let manifestCache: ModelManifest | null = null;

async function loadManifest(): Promise<ModelManifest> {
  if (manifestCache) return manifestCache;
  const res = await fetch(browser.runtime.getURL('/models.json'));
  manifestCache = (await res.json()) as ModelManifest;
  return manifestCache;
}

// ---- saving ----------------------------------------------------------------

let savedTimer = 0;
function flashSaved(): void {
  const indicator = $('saved');
  indicator.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (indicator.hidden = true), 1200);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await setSettings(patch);
  flashSaved();
}

/** Switch engine and/or voice from anywhere on the page, then redraw. */
async function useVoice(engine: EngineId, voiceId: string): Promise<void> {
  stopPreview();
  await save({ engine, [voiceKeyFor(engine)]: voiceId });
  await render();
}

// ---- engine picker ---------------------------------------------------------

/**
 * The engine list is built from the catalogue rather than hardcoded in the HTML, because how
 * good an engine is depends on the browser: Kokoro is the best option on Chromium (WebGPU) and
 * a slow curiosity on Firefox, and neither neural engine is usable on a phone.
 */
function populateEnginePicker(): void {
  const select = $<HTMLSelectElement>('engine');
  select.replaceChildren(
    ...rankedEngines().map((info) => {
      const suffix = info.standing === 'unsuitable' ? ' (not usable on this device)' : '';
      const option = el(document, 'option', { value: info.id }, `${info.name} — ${info.tag}${suffix}`);
      if (info.standing === 'unsuitable') option.classList.add('option-unsuitable');
      return option;
    }),
  );
  select.value = settings.engine;

  const active = engineInfo(settings.engine);
  $('engineHint').textContent = active.blurb;
  $('engineHint').classList.toggle('warn', active.standing === 'slow' || active.standing === 'unsuitable');
}

// ---- voice picker ----------------------------------------------------------

function populateVoicePicker(manifest: ModelManifest, sizes: CacheSizes): void {
  const select = $<HTMLSelectElement>('voice');
  const hint = $('voiceHint');
  const current = activeVoice(settings);
  const voices = usableVoices(settings.engine, manifest, sizes);

  // Keep the *currently selected* voice listed even when its files are not downloaded yet — it
  // is what will actually play, since Aloud fetches it on first use.
  if (current && !voices.some((v) => v.id === current) && settings.engine === 'piper') {
    const entry = manifest.piper[current];
    if (entry) {
      voices.unshift({
        id: current,
        label: `${entry.label.split(' — ')[0]} — downloads on first use`,
        group: entry.languageName ?? entry.language,
      });
    }
  }

  if (voices.length === 0) {
    select.replaceChildren(
      el(document, 'option', { value: '', disabled: '', selected: '' }, '— no downloaded voice —'),
    );
    select.disabled = true;
    hint.hidden = false;
    hint.textContent =
      settings.engine === 'piper'
        ? 'Download a Piper voice below, then pick it here.'
        : `Download ${engineInfo(settings.engine).name} below to unlock its voices.`;
  } else {
    select.disabled = false;
    hint.hidden = true;
    select.replaceChildren(
      ...groupByLanguage(voices).map(([language, items]) => {
        const group = el(document, 'optgroup', { label: language });
        for (const v of items) {
          const option = el(document, 'option', { value: v.id }, v.label);
          if (v.id === current) option.selected = true;
          group.appendChild(option);
        }
        return group;
      }),
    );
    if (voices.some((v) => v.id === current)) select.value = current;
  }

  $('voicePreviewSlot').replaceChildren(
    select.value ? previewFor(settings.engine, select.value, { settings, manifest, sizes }) : el(document, 'span'),
  );
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

/** Copy that depends on which browser this is, rather than assuming Firefox. */
function renderCapabilityHints(): void {
  const caps = capabilities();
  $('workersHint').textContent = caps.workerWebGPU
    ? 'Only used when synthesis falls back to the CPU. On the GPU path one worker is enough, and ' +
      'extra workers just add a copy of the model in memory. 0 = auto. Piper ignores this.'
    : 'The neural engines run several times slower than real time on the CPU, so a few sentences ' +
      'are synthesised at once to keep up with playback. 0 = auto, based on your CPU cores. Each ' +
      'extra worker adds one in-memory copy of the model (~90 MB for Kokoro), so higher is not ' +
      'always better. Piper ignores this.';

  $('webgpuHint').textContent = caps.workerWebGPU
    ? 'Your browser exposes WebGPU to extension workers, so Kokoro and Supertonic run on the GPU.'
    : caps.engine === 'gecko'
      ? 'Firefox does not yet expose WebGPU to extension workers, so this currently has no effect ' +
        'here. It is kept on so the GPU is used as soon as Firefox ships it.'
      : 'No GPU was detected for extension workers; synthesis will run on the CPU.';
}

async function render(): Promise<void> {
  settings = await getSettings();
  const manifest = await loadManifest();
  const sizes = await readCacheSizes();

  populateEnginePicker();
  populateVoicePicker(manifest, sizes);

  $<HTMLInputElement>('speed').value = String(settings.speed);
  $('speedOut').textContent = `${settings.speed.toFixed(2)}×`;
  $<HTMLInputElement>('highlight').checked = settings.highlight;
  $<HTMLInputElement>('highlightColor').value = toHex(settings.highlightColor);
  $<HTMLSelectElement>('scrollMode').value = settings.scrollMode;
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
  renderEnginePanels($('enginePanels'), ctx);

  void refreshUsage();
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

function wire(): void {
  $('engine').addEventListener('change', async (e) => {
    stopPreview();
    await save({ engine: (e.target as HTMLSelectElement).value as EngineId });
    await render();
  });
  $('voice').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value) void useVoice(settings.engine, value);
  });

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

  $('clearModels').addEventListener('click', async () => {
    if (!confirm('Delete every cached model file? They will re-download next time.')) return;
    stopPreview();
    await cacheClear();
    await render();
    flashSaved();
  });
  $('reset').addEventListener('click', async () => {
    await setSettings(DEFAULT_SETTINGS);
    await render();
  });

  window.addEventListener('pagehide', disposePreview);
}

wire();
void render();
