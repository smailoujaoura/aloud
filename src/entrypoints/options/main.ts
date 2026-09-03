import { browser } from 'wxt/browser';
import {
  getSettings,
  setSettings,
  DEFAULT_SETTINGS,
  activeVoice,
  voiceKeyFor,
  type Settings,
  type EngineId,
} from '@/shared/settings';
import {
  cacheEntries,
  cacheClear,
  cacheUsageBytes,
  cacheDelete,
  fetchModelFile,
} from '@/engine/model-cache';
import { humanBytes } from '@/shared/log';
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';
import type { EngineConfig, WorkerResponse } from '@/engine/protocol';
import {
  playClip,
  playSynthesized,
  stopPreview,
  disposePreview,
  type PreviewStatus,
} from '@/ui/voice-preview';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;
let manifestCache: ModelManifest | null = null;

async function loadManifest(): Promise<ModelManifest> {
  if (manifestCache) return manifestCache;
  const res = await fetch(browser.runtime.getURL('/models.json'));
  manifestCache = (await res.json()) as ModelManifest;
  return manifestCache;
}

// ---- generic helpers --------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const isEnglish = (lang: string): boolean => /english|^en\b/i.test(lang);

interface EngineMeta {
  name: string;
  /** Short chip shown in the panel header + engine hint. */
  tag: string;
  /** One or two sentences shown under the engine picker and in the panel. */
  blurb: string;
  /** Cache-key substring that means "the shared model is present" (Kokoro / Supertonic). */
  cacheHint?: string;
  approxSize: string;
}

const ENGINE_META: Record<EngineId, EngineMeta> = {
  piper: {
    name: 'Piper',
    tag: 'Fast · runs anywhere',
    blurb:
      'A small, fast neural voice. Comfortably faster than real-time on any machine. Each voice is a separate ~20–60 MB download.',
    approxSize: '20–60 MB per voice',
  },
  kokoro: {
    name: 'Kokoro-82M',
    tag: 'Best quality · slow on Firefox',
    blurb:
      'The most natural, expressive voice here — but ~3× slower than real-time on Firefox (no GPU, one WASM thread), so it leans on parallel workers and still needs a moment to get ahead. One 86 MB download unlocks all 54 voices.',
    cacheHint: 'Kokoro-82M',
    approxSize: '~86 MB (q8)',
  },
  supertonic: {
    name: 'Supertonic-2',
    tag: 'Expressive · medium speed',
    blurb:
      'Roughly real-time on Firefox and quite expressive. One ~262 MB download unlocks all 10 voices.',
    cacheHint: 'supertonic-2',
    approxSize: '~262 MB',
  },
};

// ---- state helpers --------------------------------------------------------

async function cacheSizes(): Promise<Map<string, number>> {
  const entries = await cacheEntries();
  return new Map(entries.map((e) => [e.key, e.size]));
}

function sharedModelBytes(sizes: Map<string, number>, hint: string): number {
  let n = 0;
  for (const [k, v] of sizes) if (k.includes(hint)) n += v;
  return n;
}

function piperDownloaded(entry: PiperVoiceEntry, sizes: Map<string, number>): boolean {
  return sizes.get(entry.config) != null && sizes.get(entry.onnx) != null;
}

/** Voices that can be *used right now* for an engine (needed to populate the Voice picker). */
function usableVoices(
  engine: EngineId,
  manifest: ModelManifest,
  sizes: Map<string, number>,
): Array<{ id: string; label: string; group: string }> {
  if (engine === 'piper') {
    return Object.entries(manifest.piper)
      .filter(([, v]) => piperDownloaded(v, sizes))
      .map(([id, v]) => ({ id, label: v.label.split(' — ')[0]!, group: v.languageName ?? v.language }));
  }
  const hint = ENGINE_META[engine].cacheHint!;
  if (sharedModelBytes(sizes, hint) === 0) return [];
  if (engine === 'kokoro') {
    return Object.entries(manifest.kokoro.voices).map(([id, v]) => ({
      id,
      label: `${v.label} · ${v.gender}`,
      group: v.language,
    }));
  }
  return Object.entries(manifest.supertonic?.voices ?? {}).map(([id, v]) => ({
    id,
    label: `${v.label} · ${v.gender}`,
    group: 'English',
  }));
}

// ---- save / toast --------------------------------------------------------

let savedTimer = 0;
function flashSaved(): void {
  const elx = $('saved');
  elx.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (elx.hidden = true), 1200);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await setSettings(patch);
  flashSaved();
}

/** Switch engine and/or voice from anywhere, then redraw. */
async function useVoice(engine: EngineId, voiceId: string): Promise<void> {
  stopPreview();
  await save({ engine, [voiceKeyFor(engine)]: voiceId });
  await render();
}

// ---- preview button -----------------------------------------------------

/**
 * A play/stop button that reflects the real preview lifecycle: download / prepare progress and a
 * "synthesising" state before it ever says "Stop", resetting itself when the preview ends,
 * errors, or is superseded by another preview.
 */
function previewButton(
  run: (onStatus: (s: PreviewStatus) => void) => Promise<void>,
  opts: { disabledReason?: string } = {},
): HTMLButtonElement {
  const btn = el('button', { class: 'model-btn preview-btn' }, '▶ Preview') as HTMLButtonElement;
  if (opts.disabledReason) {
    btn.disabled = true;
    btn.title = opts.disabledReason;
    return btn;
  }
  let active = false;
  const reset = (): void => {
    active = false;
    btn.textContent = '▶ Preview';
    btn.classList.remove('busy', 'loading');
  };
  const onStatus = (s: PreviewStatus): void => {
    if (s.error) {
      btn.title = s.error;
      btn.classList.add('error');
    } else {
      btn.classList.remove('error');
      if (s.engineInfo) btn.title = `Running on ${s.engineInfo}`;
      else btn.removeAttribute('title');
    }
    switch (s.phase) {
      case 'idle':
        reset();
        break;
      case 'loading':
        active = true;
        btn.classList.add('busy', 'loading');
        btn.textContent =
          s.progress != null && s.loadKind === 'download'
            ? `⬇ ${Math.round(s.progress * 100)}%`
            : '⚙ Preparing…';
        break;
      case 'synthesizing':
        active = true;
        btn.classList.add('busy', 'loading');
        btn.textContent = '♪ Synthesising…';
        break;
      case 'playing':
        active = true;
        btn.classList.remove('loading');
        btn.classList.add('busy');
        btn.textContent = '■ Stop';
        break;
    }
  };
  btn.addEventListener('click', () => {
    if (active) {
      stopPreview();
      return;
    }
    active = true;
    btn.classList.remove('error');
    btn.classList.add('busy', 'loading');
    btn.textContent = '⚙ Preparing…';
    void run(onStatus);
  });
  return btn;
}

function engineConfigFor(over: Partial<EngineConfig>): EngineConfig {
  const engine = (over.engine ?? settings.engine) as EngineId;
  return {
    engine,
    voice:
      over.voice ??
      (engine === 'kokoro'
        ? settings.kokoroVoice
        : engine === 'supertonic'
          ? settings.supertonicVoice
          : settings.piperVoice),
    // A preview is one sentence in one worker — always use the small q8 Kokoro weights.
    dtype: over.dtype ?? (engine === 'kokoro' ? 'q8' : settings.kokoroDtype),
    steps: over.steps ?? settings.supertonicSteps,
    preferWebGPU: over.preferWebGPU ?? settings.preferWebGPU,
    speed: settings.speed,
    workers: 1,
  };
}

/** Preview whatever `voiceId` for `engine` — hosted clip for Piper, on-device synth otherwise. */
function previewFor(
  engine: EngineId,
  voiceId: string,
  manifest: ModelManifest,
  sizes: Map<string, number>,
): HTMLButtonElement {
  if (engine === 'piper') {
    const sample = manifest.piper[voiceId]?.sample;
    if (!sample) return previewButton(async () => {}, { disabledReason: 'No preview clip for this voice' });
    return previewButton((s) => playClip(sample, s));
  }
  const hint = ENGINE_META[engine].cacheHint!;
  const ready = sharedModelBytes(sizes, hint) > 0;
  return previewButton((s) => playSynthesized(engineConfigFor({ engine, voice: voiceId }), s), {
    disabledReason: ready ? undefined : `Download ${ENGINE_META[engine].name} first to preview`,
  });
}

// ---- download plumbing --------------------------------------------------

class RowProgress {
  readonly wrap = el('div', { class: 'progress-wrap', hidden: '' });
  private readonly fill = el('i');
  readonly msg = el('div', { class: 'progress-msg', hidden: '' });
  constructor() {
    this.wrap.appendChild(this.fill);
  }
  start(label: string): void {
    this.wrap.hidden = false;
    this.msg.hidden = false;
    this.msg.classList.remove('error');
    this.msg.textContent = label;
    this.set(0);
  }
  set(ratio: number): void {
    this.fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }
  note(text: string): void {
    this.msg.hidden = false;
    this.msg.textContent = text;
  }
  fail(text: string): void {
    this.wrap.hidden = true;
    this.msg.hidden = false;
    this.msg.classList.add('error');
    this.msg.textContent = text;
  }
  done(): void {
    this.wrap.hidden = true;
    this.msg.hidden = true;
  }
}

async function downloadPiper(entry: PiperVoiceEntry, progress: RowProgress): Promise<void> {
  const totals = new Map<string, { loaded: number; total: number }>();
  const onProgress = (p: { file: string; loaded: number; total: number }): void => {
    totals.set(p.file, { loaded: p.loaded, total: Math.max(p.total, p.loaded, 1) });
    let loaded = 0;
    let total = 0;
    for (const v of totals.values()) {
      loaded += v.loaded;
      total += v.total;
    }
    progress.set(total > 0 ? loaded / total : 0);
  };
  await Promise.all([
    fetchModelFile(entry.config, { label: 'config', sha256: entry.sha256?.config, onProgress }),
    fetchModelFile(entry.onnx, { label: 'voice', sha256: entry.sha256?.onnx, onProgress }),
  ]);
}

function downloadViaWorker(config: EngineConfig, progress: RowProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(browser.runtime.getURL('/tts-worker.js'), { type: 'module', name: 'aloud-model-download' });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        worker.postMessage({ kind: 'dispose', id: 99 });
        worker.terminate();
      } catch {
        /* noop */
      }
      err ? reject(err) : resolve();
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      finish(new Error(ev.message || ev.error?.message || 'worker crashed while downloading'));
    };
    worker.onmessageerror = () => finish(new Error('worker sent an unreadable message'));
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'model-progress') {
        if (m.phase === 'compile') progress.note('Preparing model…');
        else progress.set(m.total > 0 ? m.loaded / m.total : 0);
      } else if (m.kind === 'ready') {
        finish();
      } else if (m.kind === 'error' && m.fatal) {
        finish(new Error(m.phase ? `[${m.phase}] ${m.message}` : m.message));
      }
    };
    worker.postMessage({ kind: 'init', id: 1, config } satisfies { kind: 'init'; id: number; config: EngineConfig });
  });
}

let modelActionBusy = false;

// ---- Voice picker (top section) ----------------------------------------

function populateVoicePicker(manifest: ModelManifest, sizes: Map<string, number>): void {
  const sel = $('voice') as HTMLSelectElement;
  const engine = settings.engine;
  const voices = usableVoices(engine, manifest, sizes);
  const current = activeVoice(settings);
  const filter = '';

  // Always keep the *currently selected* voice in the list even if its file isn't downloaded
  // yet — it's what will actually play (Aloud fetches it on first use).
  if (current && !voices.some((v) => v.id === current)) {
    if (engine === 'piper') {
      const e = manifest.piper[current];
      if (e) voices.unshift({ id: current, label: `${e.label.split(' — ')[0]} — downloads on first use`, group: e.languageName ?? e.language });
    }
  }

  if (voices.length === 0) {
    sel.replaceChildren(el('option', { value: '', disabled: '', selected: '' }, '— no downloaded voice —'));
    sel.disabled = true;
    $('voiceHint').hidden = false;
    $('voiceHint').textContent =
      engine === 'piper'
        ? 'Download a Piper voice below, then pick it here.'
        : `Download ${ENGINE_META[engine].name} below to unlock its voices.`;
  } else {
    sel.disabled = false;
    $('voiceHint').hidden = true;
    const byGroup = new Map<string, Array<{ id: string; label: string }>>();
    for (const v of voices) {
      if (filter && !`${v.label} ${v.group}`.toLowerCase().includes(filter)) continue;
      if (!byGroup.has(v.group)) byGroup.set(v.group, []);
      byGroup.get(v.group)!.push(v);
    }
    const nodes: Node[] = [];
    for (const [g, items] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const og = el('optgroup', { label: g });
      for (const it of items) {
        const o = el('option', { value: it.id }, it.label);
        if (it.id === current) o.selected = true;
        og.appendChild(o);
      }
      nodes.push(og);
    }
    sel.replaceChildren(...nodes);
    if (voices.some((v) => v.id === current)) sel.value = current;
  }

  // Preview button for the currently-selected voice.
  const slot = $('voicePreviewSlot');
  const pv = sel.value
    ? previewFor(engine, sel.value, manifest, sizes)
    : el('span');
  slot.replaceChildren(pv);
}

// ---- Engine panels (Voices & downloads) --------------------------------

function voiceListRow(
  engine: EngineId,
  id: string,
  label: string,
  manifest: ModelManifest,
  sizes: Map<string, number>,
  extra?: HTMLElement,
): HTMLElement {
  const row = el('div', { class: 'model-row voice-row' });
  const radio = el('input', { type: 'radio', name: 'voicePick', 'aria-label': `Use ${label}` }) as HTMLInputElement;
  radio.checked = settings.engine === engine && activeVoice(settings) === id;
  radio.addEventListener('change', () => radio.checked && void useVoice(engine, id));
  const name = el('div', { class: 'model-name' }, label);
  row.append(radio, name, el('span'), previewFor(engine, id, manifest, sizes), extra ?? el('span'));
  return row;
}

function langGroups<T>(
  entries: Array<[string, T]>,
  langOf: (v: T) => string,
  currentLang: string,
  filter: string,
  render: (k: string, v: T) => HTMLElement,
): Node[] {
  const byLang = new Map<string, Array<[string, T]>>();
  for (const [k, v] of entries) {
    const lang = langOf(v) || 'Other';
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push([k, v]);
  }
  const out: Node[] = [];
  for (const [lang, list] of [...byLang.entries()].sort((a, b) => {
    // English first, then alphabetical.
    const ae = isEnglish(a[0]) ? 0 : 1;
    const be = isEnglish(b[0]) ? 0 : 1;
    return ae - be || a[0].localeCompare(b[0]);
  })) {
    const matches = filter
      ? list.filter(([k, v]) => `${k} ${lang} ${JSON.stringify(v)}`.toLowerCase().includes(filter))
      : list;
    if (matches.length === 0) continue;
    const d = el('details', { class: 'lang-group' }) as HTMLDetailsElement;
    if (filter || isEnglish(lang) || lang === currentLang) d.open = true;
    d.appendChild(el('summary', {}, `${lang} (${list.length})`));
    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      for (const [k, v] of matches) d.appendChild(render(k, v));
    };
    if (d.open) build();
    else d.addEventListener('toggle', () => d.open && build(), { once: true });
    out.push(d);
  }
  return out;
}

function piperBody(manifest: ModelManifest, sizes: Map<string, number>, filter: string): HTMLElement {
  const body = el('div', { class: 'panel-body' });
  const entries = Object.entries(manifest.piper);
  const mine = entries.filter(([, v]) => piperDownloaded(v, sizes));
  const rest = entries.filter(([, v]) => !piperDownloaded(v, sizes));
  const currentLang = manifest.piper[settings.piperVoice]?.languageName ?? 'English';

  body.append(el('p', { class: 'sub-head' }, mine.length ? 'Your voices' : 'No Piper voices downloaded yet'));
  for (const [k, v] of mine) {
    const size = (sizes.get(v.config) ?? 0) + (sizes.get(v.onnx) ?? 0);
    const del = el('button', { class: 'model-btn' }, 'Delete') as HTMLButtonElement;
    del.addEventListener('click', async () => {
      if (modelActionBusy) return;
      modelActionBusy = true;
      del.disabled = true;
      try {
        await Promise.all([cacheDelete(v.config), cacheDelete(v.onnx)]);
        flashSaved();
        await render();
      } finally {
        modelActionBusy = false;
      }
    });
    const row = voiceListRow(
      'piper',
      k,
      `${v.label.split(' — ')[0]} · ${v.language} · ${v.quality} · ${humanBytes(size)}`,
      manifest,
      sizes,
      del,
    );
    body.append(row);
  }

  body.append(el('p', { class: 'sub-head' }, 'Add voices'));
  const groups = langGroups(
    rest,
    (v) => v.languageName ?? v.language,
    currentLang,
    filter,
    (k, v) => {
      const row = el('div', { class: 'model-row voice-row' });
      const name = el('div', { class: 'model-name' });
      name.append(
        el('b', {}, v.label.split(' — ')[0]!),
        el('small', {}, `${v.language} · ${v.quality} · ${v.sizeBytes ? humanBytes(v.sizeBytes) : '?'}`),
      );
      const progress = new RowProgress();
      const dl = el('button', { class: 'model-btn' }, 'Download') as HTMLButtonElement;
      dl.addEventListener('click', async () => {
        if (modelActionBusy) return;
        modelActionBusy = true;
        dl.disabled = true;
        try {
          progress.start(`Downloading ${v.label.split(' — ')[0]}…`);
          await downloadPiper(v, progress);
          progress.done();
          flashSaved();
          await render();
        } catch (err) {
          progress.fail(err instanceof Error ? err.message : String(err));
          dl.disabled = false;
        } finally {
          modelActionBusy = false;
        }
      });
      row.append(
        el('span'),
        name,
        el('span'),
        v.sample ? previewButton((s) => playClip(v.sample!, s)) : el('span'),
        dl,
        progress.wrap,
        progress.msg,
      );
      return row;
    },
  );
  body.append(...(groups.length ? groups : [el('p', { class: 'muted' }, 'No voices match that filter.')]));
  return body;
}

function sharedBody(
  engine: 'kokoro' | 'supertonic',
  manifest: ModelManifest,
  sizes: Map<string, number>,
  filter: string,
): HTMLElement {
  const body = el('div', { class: 'panel-body' });
  const hint = ENGINE_META[engine].cacheHint!;
  const bytes = sharedModelBytes(sizes, hint);
  const downloaded = bytes > 0;
  const licence = engine === 'kokoro' ? manifest.kokoro.license : manifest.supertonic?.license ?? '';

  const modelRow = el('div', { class: 'model-row' });
  const nm = el('div', { class: 'model-name' });
  nm.append(
    el('b', {}, `${ENGINE_META[engine].name} model`),
    el('small', {}, `${downloaded ? humanBytes(bytes) : ENGINE_META[engine].approxSize} · ${licence}`),
  );
  const progress = new RowProgress();
  const btn = el('button', { class: 'model-btn' }, downloaded ? 'Delete' : 'Download') as HTMLButtonElement;
  if (downloaded) btn.classList.add('danger');
  btn.addEventListener('click', async () => {
    if (modelActionBusy) return;
    modelActionBusy = true;
    btn.disabled = true;
    try {
      if (downloaded) {
        await cacheClear(hint);
      } else {
        progress.start(`Downloading ${ENGINE_META[engine].name}…`);
        await downloadViaWorker(engineConfigFor({ engine }), progress);
        progress.done();
      }
      flashSaved();
      await render();
    } catch (err) {
      progress.fail(err instanceof Error ? err.message : String(err));
      btn.disabled = false;
    } finally {
      modelActionBusy = false;
    }
  });
  modelRow.append(el('span'), nm, el('span'), el('span'), btn, progress.wrap, progress.msg);
  body.append(modelRow);

  if (!downloaded) {
    const count = engine === 'kokoro' ? Object.keys(manifest.kokoro.voices).length : Object.keys(manifest.supertonic?.voices ?? {}).length;
    body.append(el('p', { class: 'muted' }, `Download the model above to use its ${count} voices.`));
    return body;
  }

  if (engine === 'kokoro') {
    const entries = Object.entries(manifest.kokoro.voices);
    const currentLang = manifest.kokoro.voices[settings.kokoroVoice]?.language ?? 'American English';
    body.append(
      ...langGroups(entries, (v) => v.language, currentLang, filter, (k, v) =>
        voiceListRow('kokoro', k, `${v.label} · ${v.gender}${v.grade ? ' · ' + v.grade : ''}`, manifest, sizes),
      ),
    );
  } else {
    const entries = Object.entries(manifest.supertonic?.voices ?? {});
    for (const [k, v] of entries) {
      if (filter && !`${k} ${v.label}`.toLowerCase().includes(filter)) continue;
      body.append(voiceListRow('supertonic', k, `${v.label} · ${v.gender}`, manifest, sizes));
    }
  }
  return body;
}

function renderEnginePanels(manifest: ModelManifest, sizes: Map<string, number>): void {
  const host = $('enginePanels');
  const filter = ($('voiceFilter') as HTMLInputElement).value.trim().toLowerCase();
  const order: EngineId[] = [settings.engine, ...(['piper', 'kokoro', 'supertonic'] as EngineId[]).filter((e) => e !== settings.engine)];

  const panels = order.map((engine) => {
    const meta = ENGINE_META[engine];
    const d = el('details', { class: 'engine-panel' }) as HTMLDetailsElement;
    if (engine === settings.engine || filter) d.open = true;

    let statusText: string;
    if (engine === 'piper') {
      const n = Object.values(manifest.piper).filter((v) => piperDownloaded(v, sizes)).length;
      statusText = n ? `${n} voice${n > 1 ? 's' : ''}` : 'none yet';
    } else {
      statusText = sharedModelBytes(sizes, meta.cacheHint!) > 0 ? 'downloaded' : 'not downloaded';
    }

    const summary = el('summary');
    summary.append(
      el('b', {}, meta.name),
      el('span', { class: 'tag' }, meta.tag),
      el('span', { class: 'panel-status' }, statusText),
    );
    d.append(summary);

    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      d.append(el('p', { class: 'panel-blurb muted' }, meta.blurb));
      d.append(
        engine === 'piper'
          ? piperBody(manifest, sizes, filter)
          : sharedBody(engine, manifest, sizes, filter),
      );
    };
    if (d.open) build();
    else d.addEventListener('toggle', () => d.open && build(), { once: true });
    return d;
  });
  host.replaceChildren(...panels);
}

// ---- render ------------------------------------------------------------

function toHex(color: string): string {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return color.startsWith('#') ? color : '#ffd60a';
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

async function refreshUsage(): Promise<void> {
  const [bytes, entries] = await Promise.all([cacheUsageBytes(), cacheEntries()]);
  $('usage').textContent = entries.length
    ? `${humanBytes(bytes)} across ${entries.length} cached file(s).`
    : 'No models cached yet.';
}

async function render(): Promise<void> {
  settings = await getSettings();
  const manifest = await loadManifest();
  const sizes = await cacheSizes();

  ($('engine') as HTMLSelectElement).value = settings.engine;
  $('engineHint').textContent = ENGINE_META[settings.engine].blurb;

  populateVoicePicker(manifest, sizes);

  ($('speed') as HTMLInputElement).value = String(settings.speed);
  $('speedOut').textContent = `${settings.speed.toFixed(2)}×`;
  ($('highlight') as HTMLInputElement).checked = settings.highlight;
  ($('highlightColor') as HTMLInputElement).value = toHex(settings.highlightColor);
  ($('scrollMode') as HTMLSelectElement).value = settings.scrollMode;
  ($('sectionPauseMs') as HTMLInputElement).value = String(settings.sectionPauseMs);
  $('sectionPauseOut').textContent = `${(settings.sectionPauseMs / 1000).toFixed(2)}s`;
  ($('sentencePauseMs') as HTMLInputElement).value = String(settings.sentencePauseMs);
  $('sentencePauseOut').textContent = `${(settings.sentencePauseMs / 1000).toFixed(2)}s`;
  ($('tapToSeek') as HTMLInputElement).checked = settings.tapToSeek;
  ($('skipUrls') as HTMLInputElement).checked = settings.skipUrls;
  ($('expandAbbreviations') as HTMLInputElement).checked = settings.expandAbbreviations;

  ($('kokoroDtype') as HTMLSelectElement).value = settings.kokoroDtype;
  ($('supertonicSteps') as HTMLInputElement).value = String(settings.supertonicSteps);
  $('supertonicStepsOut').textContent = String(settings.supertonicSteps);
  ($('synthWorkers') as HTMLInputElement).value = String(settings.synthWorkers);
  $('synthWorkersOut').textContent = settings.synthWorkers === 0 ? 'auto' : String(settings.synthWorkers);
  ($('preferWebGPU') as HTMLInputElement).checked = settings.preferWebGPU;
  ($('debug') as HTMLInputElement).checked = settings.debug;
  $('kokoro-dtype-row').hidden = settings.engine !== 'kokoro';
  $('supertonic-steps-row').hidden = settings.engine !== 'supertonic';

  renderEnginePanels(manifest, sizes);
  void refreshUsage();
}

// ---- wiring -----------------------------------------------------------

function wire(): void {
  $('engine').addEventListener('change', async (e) => {
    stopPreview();
    await save({ engine: (e.target as HTMLSelectElement).value as EngineId });
    await render();
  });
  $('voice').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) void useVoice(settings.engine, v);
  });
  $('speed').addEventListener('input', (e) => {
    $('speedOut').textContent = `${Number((e.target as HTMLInputElement).value).toFixed(2)}×`;
  });
  $('speed').addEventListener('change', (e) => save({ speed: Number((e.target as HTMLInputElement).value) }));

  $('highlight').addEventListener('change', (e) => save({ highlight: (e.target as HTMLInputElement).checked }));
  $('highlightColor').addEventListener('change', (e) => {
    const hex = (e.target as HTMLInputElement).value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    void save({ highlightColor: `rgba(${r}, ${g}, ${b}, 0.45)` });
  });
  $('scrollMode').addEventListener('change', (e) => save({ scrollMode: (e.target as HTMLSelectElement).value as Settings['scrollMode'] }));
  const pauseSlider = (id: string, out: string, key: 'sectionPauseMs' | 'sentencePauseMs') => {
    $(id).addEventListener('input', (e) => {
      $(out).textContent = `${(Number((e.target as HTMLInputElement).value) / 1000).toFixed(2)}s`;
    });
    $(id).addEventListener('change', (e) => save({ [key]: Number((e.target as HTMLInputElement).value) }));
  };
  pauseSlider('sectionPauseMs', 'sectionPauseOut', 'sectionPauseMs');
  pauseSlider('sentencePauseMs', 'sentencePauseOut', 'sentencePauseMs');
  $('tapToSeek').addEventListener('change', (e) => save({ tapToSeek: (e.target as HTMLInputElement).checked }));
  $('skipUrls').addEventListener('change', (e) => save({ skipUrls: (e.target as HTMLInputElement).checked }));
  $('expandAbbreviations').addEventListener('change', (e) => save({ expandAbbreviations: (e.target as HTMLInputElement).checked }));

  $('kokoroDtype').addEventListener('change', async (e) => {
    await save({ kokoroDtype: (e.target as HTMLSelectElement).value as Settings['kokoroDtype'] });
    await render();
  });
  $('supertonicSteps').addEventListener('input', (e) => {
    $('supertonicStepsOut').textContent = (e.target as HTMLInputElement).value;
  });
  $('supertonicSteps').addEventListener('change', (e) => save({ supertonicSteps: Number((e.target as HTMLInputElement).value) }));
  $('synthWorkers').addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    $('synthWorkersOut').textContent = v === 0 ? 'auto' : String(v);
  });
  $('synthWorkers').addEventListener('change', (e) => save({ synthWorkers: Number((e.target as HTMLInputElement).value) }));
  $('preferWebGPU').addEventListener('change', (e) => save({ preferWebGPU: (e.target as HTMLInputElement).checked }));
  $('debug').addEventListener('change', (e) => save({ debug: (e.target as HTMLInputElement).checked }));

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
