/**
 * The Voice page's top half: who reads what, and the voices you keep.
 *
 * The page used to open on a catalogue of 222 voices, with "which voice reads Italian" as a row
 * of dropdowns above it. That is the question people come here with, so it now comes first, drawn
 * rather than listed: a switchboard with each language on the left, the faces of the voices that
 * can read it on the right, and a wire from the language to the one that does. Click another
 * face and the wire swings over to it. "Auto" leaves the choice to the reader — your voice where
 * it speaks the language, otherwise the best one downloaded — and the wire shows which that is.
 *
 * Under it, "My voices": the downloaded voices you keep, as faces. Put one away and it leaves the
 * reading bar and this board; the catalogue below (browse, download, bring back) stays folded
 * until it is wanted.
 */
import { el } from '@/shared/dom';
import { engineInfo } from '@/shared/engine-catalog';
import { languageName, primaryLanguage, voiceLanguage, type CandidateVoice } from '@/shared/language-voice';
import { activeVoice, type EngineId } from '@/shared/settings';
import { listVoices } from '@/shared/voice-catalog';
import { piperDownloaded, sharedModelInstalled } from '@/engine/installed-voices';
import { routeFor } from '@/content/voice-routing';
import { genericAvatar } from '@/ui/voice-avatar';
import { voicePortrait } from '@/ui/voice-portraits';
import { shortPiperLabel } from '@/shared/voice-catalog';
import { previewFor } from './preview-button';
import type { PanelContext } from './voice-panels';

export const voiceKeyOf = (engine: EngineId, id: string): string => `${engine}:${id}`;

/** A voice's face: its portrait, or the one stand-in avatar. */
export function face(engine: EngineId, id: string, size = 40, className = 'vi-avatar'): HTMLElement {
  const node = el(document, 'span', { class: className, 'aria-hidden': 'true' });
  node.style.width = node.style.height = `${size}px`;
  const drawn = () => genericAvatar(document, size);
  const portrait = voicePortrait(engine, id);
  if (!portrait) {
    node.append(drawn());
    return node;
  }
  // Not a real person: said where the face is, with who the voice sounds like.
  node.classList.add('has-photo');
  node.title = `Sounds like ${portrait.sounds}. Portrait generated — not a real person.`;
  node.removeAttribute('aria-hidden');
  const img = el(document, 'img', { src: portrait.file, alt: '', width: String(size), height: String(size), decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(drawn()), { once: true });
  node.append(img);
  return node;
}

/** Every voice whose files are on this device, with the language it speaks. */
export function downloadedVoices(ctx: Pick<PanelContext, 'manifest' | 'sizes'>): CandidateVoice[] {
  const out: CandidateVoice[] = [];
  for (const [id, entry] of Object.entries(ctx.manifest.piper)) {
    if (piperDownloaded(entry, ctx.sizes)) out.push({ engine: 'piper', id, label: shortPiperLabel(entry.label), language: entry.language });
  }
  if (sharedModelInstalled('kokoro', ctx.sizes)) {
    for (const [id, v] of Object.entries(ctx.manifest.kokoro.voices)) out.push({ engine: 'kokoro', id, label: v.label, language: v.language });
  }
  if (sharedModelInstalled('supertonic', ctx.sizes)) {
    for (const [id, v] of Object.entries(ctx.manifest.supertonic?.voices ?? {})) out.push({ engine: 'supertonic', id, label: v.label, language: 'en' });
  }
  return out;
}

export function shortName(label: string): string {
  return label.split(' · ')[0] ?? label;
}

/** "English (UK)": the language, with the region as a code where the tag names one. */
export function languageLabel(tag: string): string {
  const [lang, region] = tag.replace('_', '-').split('-');
  const name = languageName(lang ?? tag);
  if (!region) return name;
  const code = region.toUpperCase() === 'GB' ? 'UK' : region.toUpperCase();
  return `${name} (${code})`;
}

/** "British", for a voice whose language tag names a region; '' otherwise. */
export function regionName(tag: string): string {
  const region = tag.replace('_', '-').split('-')[1];
  if (!region) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(region.toUpperCase()) ?? region;
  } catch {
    return region;
  }
}

function savedVoice(ctx: PanelContext): CandidateVoice {
  const { settings, manifest } = ctx;
  const id = activeVoice(settings);
  return {
    engine: settings.engine,
    id,
    label: listVoices(settings.engine, manifest).find((v) => v.id === id)?.label ?? id,
    language: voiceLanguage(settings.engine, id, manifest),
  };
}

/** Faces shown per language before "+ more" — enough to choose from, never a wall. */
const FACES_PER_ROW = 5;
/** Tiles shown in My voices before "Show all". */
const TILES_SHOWN = 12;
let showAllMine = false;

/**
 * The switchboard. One row per language a kept voice speaks (and any language a voice was
 * chosen for): the language, its candidates as faces, and a wire to the one reading it.
 */
export function renderVoiceBoard(
  host: HTMLElement,
  ctx: PanelContext,
  openCatalogue: (language?: string, showHidden?: boolean, engine?: EngineId) => void,
): void {
  const { settings } = ctx;
  const installed = downloadedVoices(ctx);
  const hidden = new Set(settings.hiddenVoices);
  const saved = savedVoice(ctx);
  const savedLanguage = primaryLanguage(saved.language);
  const kept = installed.filter((v) => !hidden.has(voiceKeyOf(v.engine, v.id)));

  const head = el(document, 'div', { class: 'vb-head' });
  const title = el(document, 'div', {});
  title.append(
    el(document, 'h3', { id: 'langVoiceHeading' }, 'Who reads what'),
    el(document, 'p', { class: 'muted small' }, 'Each language is read by the voice its wire leads to. Click a face to rewire it.'),
  );
  const toggle = el(document, 'label', { class: 'switch' });
  const box = el(document, 'input', { type: 'checkbox', id: 'matchPageLanguage', role: 'switch' }) as HTMLInputElement;
  box.checked = settings.matchPageLanguage;
  box.addEventListener('change', () => void ctx.setAutoLanguage(box.checked));
  toggle.append(box, el(document, 'span', { class: 'switch-track', 'aria-hidden': 'true' }), el(document, 'span', {}, 'Switch voices with the language'));
  head.append(title, toggle);

  const board = el(document, 'div', { class: `vb-board${settings.matchPageLanguage ? '' : ' is-off'}` });
  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wires.classList.add('vb-wires');
  wires.setAttribute('aria-hidden', 'true');
  board.append(wires);

  const codes = new Set<string>([...kept.map((v) => primaryLanguage(v.language)), ...Object.keys(settings.languageVoices)]);
  codes.delete('');
  const ordered = [...codes].sort((a, b) =>
    a === savedLanguage ? -1 : b === savedLanguage ? 1 : languageName(a).localeCompare(languageName(b)),
  );

  const links: Array<{ from: HTMLElement; to: HTMLElement; auto: boolean }> = [];
  for (const code of ordered) {
    const chosen = settings.languageVoices[code];
    const route = routeFor(code, { auto: true, manual: null, saved, preferences: {}, installed, skip: new Set(), hidden });
    const automatic = route.kind === 'voice' && route.reason !== 'missing' ? route.voice : null;
    const isChosen = (v: CandidateVoice): boolean => !!chosen && chosen.engine === v.engine && chosen.voice === v.id;
    const reading = chosen ? installed.find(isChosen) ?? null : automatic;

    // Candidates: the kept voices that speak it, the one reading first among equals.
    const speakers = installed.filter((v) => primaryLanguage(v.language) === code && (!hidden.has(voiceKeyOf(v.engine, v.id)) || isChosen(v)));
    const isReading = (v: CandidateVoice): boolean => !!reading && reading.engine === v.engine && reading.id === v.id;
    speakers.sort((a, b) => Number(isReading(b)) - Number(isReading(a)));

    const row = el(document, 'div', { class: 'vb-row', role: 'radiogroup', 'aria-label': `Voice for ${languageName(code)}` });
    const lang = el(document, 'div', { class: 'vb-lang' });
    lang.append(
      el(document, 'b', {}, languageName(code)),
      el(document, 'span', {}, chosen ? 'Chosen by you' : code === savedLanguage && automatic?.id === saved.id ? 'Your voice' : automatic ? 'Auto' : 'No voice kept'),
    );
    const node = el(document, 'span', { class: 'vb-node', 'aria-hidden': 'true' });

    const faces = el(document, 'div', { class: 'vb-faces' });
    const auto = el(document, 'button', {
      type: 'button',
      class: `vb-auto${chosen ? '' : ' is-on'}`,
      role: 'radio',
      'aria-checked': String(!chosen),
      title: automatic ? `Auto — ${shortName(automatic.label)} now; it follows your voice and what you download` : 'Auto',
    }, 'Auto');
    auto.addEventListener('click', () => {
      if (chosen) void ctx.setLanguageVoice(code, null);
    });
    // In the language's own box, so the wire runs clear from the language to its face.
    lang.append(auto, node);

    let target: HTMLElement | null = null;
    // Room for "+N" on the same line when there are more than fit.
    const showing = speakers.length > FACES_PER_ROW ? FACES_PER_ROW - 1 : FACES_PER_ROW;
    for (const v of speakers.slice(0, showing)) {
      const on = isReading(v);
      const btn = el(document, 'button', {
        type: 'button',
        class: `vb-face${on ? ' is-reading' : ''}${on && !chosen ? ' is-auto' : ''}`,
        role: 'radio',
        'aria-checked': String(on && !!chosen),
        title: `${shortName(v.label)} · ${engineInfo(v.engine).name}${regionName(v.language) ? ` · ${regionName(v.language)}` : ''}`,
      });
      btn.append(face(v.engine, v.id, on ? 48 : 36), el(document, 'span', { class: 'vb-face-name' }, shortName(v.label)));
      btn.addEventListener('click', () => {
        if (!(chosen && isChosen(v))) void ctx.setLanguageVoice(code, { engine: v.engine, voice: v.id });
      });
      faces.append(btn);
      if (on) target = btn;
    }
    if (speakers.length > showing) {
      const more = el(document, 'button', { type: 'button', class: 'vb-more' }, `+${speakers.length - showing}`);
      more.title = `All ${languageName(code)} voices`;
      // The catalogue opens on the engine most of the rest belong to.
      const rest = speakers.slice(showing);
      const engine = (['kokoro', 'piper', 'supertonic'] as const).reduce((a, b) =>
        rest.filter((v) => v.engine === b).length > rest.filter((v) => v.engine === a).length ? b : a,
      );
      more.addEventListener('click', () => openCatalogue(code, false, engine));
      faces.append(more);
    }
    if (!speakers.length) {
      const get = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, `Get a ${languageName(code)} voice`);
      get.addEventListener('click', () => openCatalogue(code));
      faces.append(get);
    }
    if (target) links.push({ from: node, to: target, auto: !chosen });
    row.append(lang, faces);
    board.append(row);
  }

  if (!ordered.length) {
    const empty = el(document, 'div', { class: 'vb-empty' });
    empty.append(el(document, 'p', {}, 'No voices on this device yet. Download one and it appears here, wired to its language.'));
    const go = el(document, 'button', { type: 'button', class: 'primary' }, 'Browse voices');
    go.addEventListener('click', () => openCatalogue());
    empty.append(go);
    board.append(empty);
  }

  const add = el(document, 'button', { type: 'button', class: 'ghost btn-sm vb-add' }, '+ Another language');
  add.addEventListener('click', () => openCatalogue());
  const note = el(
    document,
    'p',
    { class: 'muted small vb-note' },
    settings.matchPageLanguage
      ? 'Auto: your voice where it speaks the language, otherwise the best voice you keep that does.'
      : `Switching is off — every language is read by ${shortName(saved.label)}.`,
  );
  const foot = el(document, 'div', { class: 'vb-foot' });
  foot.append(note, add);

  host.replaceChildren(head, board, foot);
  drawWires(board, wires, links);
  // Wires follow the layout: a narrower window wraps the faces.
  boardObserver?.disconnect();
  boardObserver = null;
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => drawWires(board, wires, links));
  observer.observe(board);
  boardObserver = observer;
}

let boardObserver: ResizeObserver | null = null;

/** One curve per language, from its node to the face reading it. */
function drawWires(board: HTMLElement, svg: SVGSVGElement, links: Array<{ from: HTMLElement; to: HTMLElement; auto: boolean }>): void {
  const box = board.getBoundingClientRect();
  svg.setAttribute('width', String(box.width));
  svg.setAttribute('height', String(box.height));
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const ns = 'http://www.w3.org/2000/svg';
  const paths = links.map(({ from, to, auto }) => {
    const a = from.getBoundingClientRect();
    const b = to.querySelector('.vi-avatar')?.getBoundingClientRect() ?? to.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - box.left;
    const y1 = a.top + a.height / 2 - box.top;
    const x2 = b.left - box.left;
    const y2 = b.top + b.height / 2 - box.top;
    const bend = Math.max(24, (x2 - x1) * 0.45);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', auto ? 'vb-wire is-auto' : 'vb-wire');
    return path;
  });
  svg.replaceChildren(...paths);
}

/**
 * "My voices": the downloaded voices you keep, as faces to try, use, or put away. What is put away
 * leaves the reading bar and the switchboard; it stays downloaded, and comes back from the
 * catalogue.
 */
/** Every voice wired on the switchboard: your voice, the ones chosen, the ones Auto picks now. */
export function wiredVoices(ctx: PanelContext): Set<string> {
  const { settings } = ctx;
  const installed = downloadedVoices(ctx);
  const hidden = new Set(settings.hiddenVoices);
  const saved = savedVoice(ctx);
  const keys = new Set([voiceKeyOf(saved.engine, saved.id), ...Object.values(settings.languageVoices).map((r) => voiceKeyOf(r.engine, r.voice))]);
  for (const code of new Set(installed.map((v) => primaryLanguage(v.language)))) {
    if (!code || settings.languageVoices[code]) continue;
    const route = routeFor(code, { auto: true, manual: null, saved, preferences: {}, installed, skip: new Set(), hidden });
    if (route.kind === 'voice' && route.reason !== 'missing') keys.add(voiceKeyOf(route.voice.engine, route.voice.id));
  }
  return keys;
}

export function renderMyVoices(host: HTMLElement, ctx: PanelContext, openCatalogue: (language?: string, showHidden?: boolean) => void): void {
  const { settings } = ctx;
  const installed = downloadedVoices(ctx);
  const hidden = new Set(settings.hiddenVoices);
  const saved = savedVoice(ctx);
  const kept = installed.filter((v) => !hidden.has(voiceKeyOf(v.engine, v.id)));
  const putAway = installed.length - kept.length;

  const head = el(document, 'div', { class: 'vb-head' });
  const title = el(document, 'div', {});
  title.append(
    el(document, 'h3', {}, `My voices${kept.length ? ` · ${kept.length}` : ''}`),
    el(document, 'p', { class: 'muted small' }, 'The voices the reading bar offers. Try them, keep the ones you like, put the rest away.'),
  );
  head.append(title);
  const wired = wiredVoices(ctx);
  if (kept.some((v) => !wired.has(voiceKeyOf(v.engine, v.id)))) {
    const tidy = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Keep only the ones I use');
    tidy.title = 'Put away every voice that is not wired to a language above — one per language stays';
    tidy.addEventListener('click', () => {
      const keep = wiredVoices(ctx);
      void ctx.setHiddenVoices([...hidden, ...kept.map((v) => voiceKeyOf(v.engine, v.id)).filter((k) => !keep.has(k))]);
    });
    head.append(tidy);
  }

  const grid = el(document, 'div', { class: 'mv-grid' });
  const byLanguage = [...kept].sort(
    (a, b) =>
      Number(b.id === saved.id && b.engine === saved.engine) - Number(a.id === saved.id && a.engine === saved.engine) ||
      languageName(primaryLanguage(a.language)).localeCompare(languageName(primaryLanguage(b.language))) ||
      a.label.localeCompare(b.label),
  );
  for (const v of byLanguage) {
    const mine = v.engine === saved.engine && v.id === saved.id;
    const tile = el(document, 'div', { class: `mv-tile${mine ? ' is-mine' : ''}` });
    const text = el(document, 'div', { class: 'mv-text' });
    text.append(
      el(document, 'b', {}, shortName(v.label)),
      el(document, 'span', {}, `${languageLabel(v.language)} · ${engineInfo(v.engine).name}`),
    );
    const actions = el(document, 'div', { class: 'mv-actions' });
    const preview = previewFor(v.engine, v.id, ctx);
    preview.classList.add('mv-play');
    actions.append(preview);
    if (mine) actions.append(el(document, 'span', { class: 'pill in-use' }, 'Your voice'));
    else {
      const use = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Use');
      use.title = `Make ${shortName(v.label)} your voice — the one that reads by default`;
      use.addEventListener('click', () => void ctx.useVoice(v.engine, v.id));
      actions.append(use);
      const away = el(document, 'button', { type: 'button', class: 'ghost btn-sm mv-away', 'aria-label': `Put ${shortName(v.label)} away`, title: 'Put away — off the reading bar and this page; still downloaded' }, '✕');
      away.addEventListener('click', () => void ctx.setHiddenVoices([...hidden, voiceKeyOf(v.engine, v.id)]));
      actions.append(away);
    }
    tile.append(face(v.engine, v.id, 44), text, actions);
    grid.append(tile);
  }
  // A model with forty voices is forty tiles: the first dozen, then the rest on asking.
  const tiles = [...grid.children];
  if (!showAllMine && tiles.length > TILES_SHOWN + 2) {
    for (const t of tiles.slice(TILES_SHOWN)) (t as HTMLElement).hidden = true;
  }
  if (!kept.length) grid.append(el(document, 'p', { class: 'muted small' }, installed.length ? 'Every voice is put away.' : 'None yet.'));

  const foot = el(document, 'div', { class: 'vb-foot' });
  if (kept.length > TILES_SHOWN + 2) {
    const all = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, showAllMine ? 'Show fewer' : `Show all ${kept.length}`);
    all.addEventListener('click', () => {
      showAllMine = !showAllMine;
      renderMyVoices(host, ctx, openCatalogue);
    });
    foot.append(all);
  }
  if (putAway) {
    const back = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, `${putAway} put away — see them`);
    back.addEventListener('click', () => openCatalogue(undefined, true));
    foot.append(back);
  }
  host.replaceChildren(head, grid, foot);
}
