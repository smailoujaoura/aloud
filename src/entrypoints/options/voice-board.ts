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
 * Every downloaded voice that speaks a language is offered on its row, with a play button on its
 * face. A language with no voice of its own — none downloaded, or taken off the board — is read
 * like every other language: the last row, by the voice English gets, any voice chosen, or none.
 *
 * Under it, the catalogue: every voice there is, to browse and download.
 */
import { el } from '@/shared/dom';
import { engineInfo } from '@/shared/engine-catalog';
import { languageName, primaryLanguage, voiceLanguage, type CandidateVoice } from '@/shared/language-voice';
import { activeVoice, type EngineId } from '@/shared/settings';
import { listVoices } from '@/shared/voice-catalog';
import { piperDownloaded, sharedModelInstalled } from '@/engine/installed-voices';
import { fallbackVoice, routeFor } from '@/content/voice-routing';
import { genericAvatar } from '@/ui/voice-avatar';
import { voicePortrait } from '@/ui/voice-portraits';
import { shortPiperLabel } from '@/shared/voice-catalog';
import { previewFor } from './preview-button';
import type { PanelContext } from './voice-panels';

/** The board's last row: every language without voices of its own. */
export const OTHER_LANGUAGES = '*';

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
  return out;
}

/** The flags bundled in `public/flags/` (flag-icons, MIT): the countries Aloud's voices name. */
const FLAGS = new Set('al am ar bd be bg br cd cn cz de dk ee es fi fr gb ge gr hu id in ir is it jo kr kz lu lv mx nl no np pk pl pt ro rs ru se si sk tr ua us vn'.split(' '));
/** For a language whose voices name no country (Kokoro's "it", "hi", "es"). */
const HOME_COUNTRY: Record<string, string> = { en: 'gb', es: 'es', fr: 'fr', it: 'it', hi: 'in', pt: 'pt', de: 'de', zh: 'cn', ja: 'jp', ko: 'kr' };

/**
 * A small flag for a language row: the country of the voice reading it (en_US → the US, en_GB →
 * the UK, pt_BR → Brazil), else the language's home. A flag stands for a country, not a language —
 * so it follows the voice actually heard. Null when none is bundled.
 */
export function flagFor(code: string, voice?: CandidateVoice | null): HTMLImageElement | null {
  const region = voice?.language.replace('_', '-').split('-')[1]?.toLowerCase();
  const country = region && FLAGS.has(region) ? region : HOME_COUNTRY[code];
  if (!country || !FLAGS.has(country)) return null;
  return el(document, 'img', { class: 'vb-flag', src: `/flags/${country}.svg`, alt: '', width: '20', height: '15', decoding: 'async' }) as HTMLImageElement;
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

/**
 * The switchboard. One row per language a downloaded voice speaks (and any a voice was chosen
 * for), unless taken off: the language, Auto, every voice that can read it in a strip that scrolls
 * sideways, and a wire to the one reading it. The last row is every other language: read by the
 * voice English gets, by any voice chosen, or not at all — and it lists the languages taken off.
 */
export function renderVoiceBoard(
  host: HTMLElement,
  ctx: PanelContext,
  openCatalogue: (language?: string, showHidden?: boolean, engine?: EngineId) => void,
): void {
  const { settings } = ctx;
  const installed = downloadedVoices(ctx);
  const saved = savedVoice(ctx);
  const savedLanguage = primaryLanguage(saved.language);
  const removed = new Set(settings.removedLanguages);
  const routing = {
    auto: true,
    manual: null,
    saved,
    preferences: settings.languageVoices,
    installed,
    skip: new Set<string>(),
    other: settings.otherVoice,
  };
  const skipping = settings.unvoicedLanguages === 'skip';

  const head = el(document, 'div', { class: 'vb-head' });
  const title = el(document, 'div', {});
  title.append(
    el(document, 'h3', { id: 'langVoiceHeading' }, 'Who reads what'),
    el(document, 'p', { class: 'muted small' }, 'Click a face to choose who reads a language; ▶ to hear it first.'),
  );
  head.append(title);

  const board = el(document, 'div', { class: 'vb-board' });
  const wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wires.classList.add('vb-wires');
  wires.setAttribute('aria-hidden', 'true');
  board.append(wires);

  const codes = new Set<string>([...installed.map((v) => primaryLanguage(v.language)), ...Object.keys(settings.languageVoices)]);
  codes.delete('');
  for (const code of removed) codes.delete(code);
  const ordered = [...codes].sort((a, b) =>
    a === savedLanguage ? -1 : b === savedLanguage ? 1 : languageName(a).localeCompare(languageName(b)),
  );

  const links: Array<{ from: HTMLElement; to: HTMLElement; auto: boolean }> = [];
  for (const code of ordered) {
    const chosen = settings.languageVoices[code];
    const route = routeFor(code, { ...routing, preferences: {} });
    const automatic = route.kind === 'voice' && route.reason !== 'missing' ? route.voice : null;
    const isChosen = (v: CandidateVoice): boolean => !!chosen && chosen.engine === v.engine && chosen.voice === v.id;
    const reading = chosen ? installed.find(isChosen) ?? automatic : automatic;
    const isReading = (v: CandidateVoice): boolean => !!reading && reading.engine === v.engine && reading.id === v.id;
    // Every downloaded voice for it, the reading one first.
    const speakers = installed
      .filter((v) => primaryLanguage(v.language) === code)
      .sort((a, b) => Number(isReading(b)) - Number(isReading(a)));

    const row = el(document, 'div', { class: 'vb-row', role: 'radiogroup', 'aria-label': `Voice for ${languageName(code)}` });
    const lang = el(document, 'div', { class: 'vb-lang' });
    const named = el(document, 'b', {}, languageName(code));
    const flag = flagFor(code, reading ?? speakers[0] ?? null);
    if (flag) named.prepend(flag);
    const node = el(document, 'span', { class: 'vb-node', 'aria-hidden': 'true' });
    const auto = el(document, 'button', {
      type: 'button',
      class: `vb-auto${chosen ? '' : ' is-on'}`,
      role: 'radio',
      'aria-checked': String(!chosen),
      title: automatic ? `Auto: ${shortName(automatic.label)} now — Aloud picks, and follows what you download` : 'Auto',
    }, 'Auto');
    auto.addEventListener('click', () => {
      if (chosen) void ctx.setLanguageVoice(code, null);
    });
    const remove = el(document, 'button', {
      type: 'button',
      class: 'vb-remove',
      'aria-label': `Remove ${languageName(code)}`,
      title: `Don't read ${languageName(code)} with its own voices: read it like every other language`,
    }, '✕');
    remove.addEventListener('click', () => void ctx.setLanguageRemoved(code, true));
    const line = el(document, 'span', { class: 'vb-name' });
    line.append(named, remove);
    lang.append(line, el(document, 'span', {}, chosen && reading ? 'Chosen by you' : reading ? 'Auto' : 'No voice yet'), auto, node);

    const faces = el(document, 'div', { class: 'vb-faces' });
    let target: HTMLElement | null = null;
    for (const v of speakers) {
      const on = isReading(v);
      const { pick, btn } = faceChoice(v, ctx, { on, auto: on && !chosen, checked: on && !!chosen });
      btn.addEventListener('click', () => {
        if (!(on && chosen)) void ctx.chooseVoice(code, v.engine, v.id);
      });
      faces.append(pick);
      if (on) target = btn;
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

  // Every other language: any voice may read it, Auto (the voice English gets), or none.
  if (installed.length) {
    const others = fallbackVoice(routing);
    const row = el(document, 'div', { class: 'vb-row vb-others', role: 'radiogroup', 'aria-label': 'Voice for every other language' });
    const lang = el(document, 'div', { class: 'vb-lang' });
    const node = el(document, 'span', { class: 'vb-node', 'aria-hidden': 'true' });
    const auto = el(document, 'button', {
      type: 'button',
      class: `vb-auto${!settings.otherVoice && !skipping ? ' is-on' : ''}`,
      role: 'radio',
      'aria-checked': String(!settings.otherVoice && !skipping),
      title: 'Auto: the voice that reads English',
    }, 'Auto');
    auto.addEventListener('click', () => void ctx.setOtherVoice(null));
    const skip = el(document, 'button', {
      type: 'button',
      class: `vb-auto${skipping ? ' is-on' : ''}`,
      role: 'radio',
      'aria-checked': String(skipping),
      title: 'Not read at all',
    }, 'Skip');
    skip.addEventListener('click', () => {
      if (!skipping) void ctx.setUnvoiced('skip');
    });
    const chips = el(document, 'span', { class: 'vb-modes' });
    chips.append(auto, skip);
    lang.append(
      el(document, 'b', {}, 'Every other language'),
      el(document, 'span', {}, skipping ? 'Not read' : `Read by ${shortName(others.label)}`),
      chips,
      node,
    );
    if (removed.size) {
      const back = el(document, 'span', { class: 'vb-removed' });
      for (const code of [...removed].sort()) {
        const chip = el(document, 'button', { type: 'button', class: 'vb-back', title: `Give ${languageName(code)} its own voices again` }, `${languageName(code)} ↩`);
        chip.addEventListener('click', () => void ctx.setLanguageRemoved(code, false));
        back.append(chip);
      }
      lang.append(back);
    }
    const faces = el(document, 'div', { class: `vb-faces${skipping ? ' is-off' : ''}` });
    const isOther = (v: CandidateVoice): boolean => !skipping && others.engine === v.engine && others.id === v.id;
    const everyone = [...installed].sort(
      (a, b) =>
        Number(isOther(b)) - Number(isOther(a)) ||
        languageName(primaryLanguage(a.language)).localeCompare(languageName(primaryLanguage(b.language))),
    );
    let target: HTMLElement | null = null;
    for (const v of everyone) {
      const on = isOther(v);
      const { pick, btn } = faceChoice(v, ctx, { on, auto: on && !settings.otherVoice, checked: on && !!settings.otherVoice });
      btn.addEventListener('click', () => {
        if (!(on && settings.otherVoice)) void ctx.chooseVoice(OTHER_LANGUAGES, v.engine, v.id);
      });
      faces.append(pick);
      if (on) target = btn;
    }
    if (target) links.push({ from: node, to: target, auto: !settings.otherVoice });
    row.append(lang, faces);
    board.append(row);
  } else {
    const empty = el(document, 'div', { class: 'vb-empty' });
    empty.append(el(document, 'p', {}, 'No voices on this device yet. Download one below and it appears here, wired to its language.'));
    board.append(empty);
  }

  const add = el(document, 'button', { type: 'button', class: 'ghost btn-sm vb-add' }, '+ Another language');
  add.addEventListener('click', () => openCatalogue());
  const foot = el(document, 'div', { class: 'vb-foot' });
  foot.append(add);

  host.replaceChildren(head, board, foot);
  drawWires(board, wires, links);
  for (const strip of board.querySelectorAll('.vb-faces')) strip.addEventListener('scroll', () => drawWires(board, wires, links), { passive: true });
  // Wires follow the layout: a narrower window moves the faces.
  boardObserver?.disconnect();
  boardObserver = null;
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => drawWires(board, wires, links));
  observer.observe(board);
  boardObserver = observer;
}

let boardObserver: ResizeObserver | null = null;

/**
 * One face on the board: the voice, which wires its language when clicked, and beside it a play
 * button to hear it first. Two buttons side by side — a button cannot hold another.
 */
function faceChoice(
  v: CandidateVoice,
  ctx: PanelContext,
  state: { on: boolean; auto: boolean; checked: boolean; caption?: string },
): { pick: HTMLElement; btn: HTMLButtonElement } {
  const name = shortName(v.label);
  const pick = el(document, 'span', { class: 'vb-pick' });
  const btn = el(document, 'button', {
    type: 'button',
    class: `vb-face${state.on ? ' is-reading' : ''}${state.auto ? ' is-auto' : ''}`,
    role: 'radio',
    'aria-checked': String(state.checked),
    title: `${name} · ${engineInfo(v.engine).name}${regionName(v.language) ? ` · ${regionName(v.language)}` : ''}`,
  }) as HTMLButtonElement;
  btn.append(face(v.engine, v.id, state.on ? 48 : 36), el(document, 'span', { class: 'vb-face-name' }, state.caption ?? name));
  const play = previewFor(v.engine, v.id, ctx, { compact: true, label: `Preview ${name}` });
  play.classList.add('vb-play');
  pick.append(btn, play);
  return { pick, btn };
}

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
    // Scrolled out of its strip: the wire ends at the strip's edge.
    const strip = to.closest('.vb-faces')?.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - box.left;
    const y1 = a.top + a.height / 2 - box.top;
    const x2 = (strip ? Math.min(Math.max(b.left, strip.left), strip.right) : b.left) - box.left;
    const y2 = b.top + b.height / 2 - box.top;
    const bend = Math.max(24, (x2 - x1) * 0.45);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', auto ? 'vb-wire is-auto' : 'vb-wire');
    return path;
  });
  svg.replaceChildren(...paths);
}
