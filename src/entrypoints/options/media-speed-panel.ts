/**
 * The settings page's video & audio speed section.
 *
 * Three parts: where the control runs (its shortcut, and the sites it starts on by itself), what
 * each key does, and how it behaves (opening speed, memory, badge, the button on the video).
 *
 * Each key sits beside the value it uses, in a line that reads as what it does: "S slower, D
 * faster, by 0.25×", "G jumps to 1.5× and back to 1×". The values above and the keys below, apart,
 * read as settings of the reading voice, and as broken (#12). A key is set by pressing the key you
 * want, since that is the only way to say "the key left of L" on a keyboard that is not the author's.
 */
import { el } from '@/shared/dom';
import { clampRate, formatRate } from '@/media-speed/rate';
import { comboFromEvent, formatBinding } from '@/media-speed/keys';
import { clearSiteSpeeds, loadSiteSpeeds } from '@/media-speed/site-speeds';
import { clearTouchSpots } from '@/media-speed/touch-button';
import { DEFAULT_MEDIA_SPEED, type MediaSpeedSettings } from '@/shared/settings';
import { renderSiteList } from './site-list';
import { capabilities } from '@/shared/browser-env';
import { beginRecording, stopIfRecording } from './key-recorder';
import { browser } from 'wxt/browser';

export interface MediaSpeedPanelOptions {
  settings: MediaSpeedSettings;
  save(patch: Partial<MediaSpeedSettings>): Promise<void>;
  toast(message: string): void;
}

type KeyName = keyof MediaSpeedSettings['keys'];

export function renderMediaSpeedPanel(host: HTMLElement, opts: MediaSpeedPanelOptions): void {
  const s = opts.settings;
  const rows: HTMLElement[] = [];
  // A phone has no keys: the control is the button on the video (media-speed/touch-button.ts).
  const phone = capabilities().touchFirst;

  // ---- where it runs ----
  if (phone) rows.push(everyVideoRow(s, opts));
  else rows.push(startHint());
  const sites = el(document, 'div', { class: 'speed-sites' });
  renderSiteList(sites, {
    heading: 'Starts by itself on',
    empty: 'No sites yet. The shortcut works everywhere.',
    what: 'the speed control',
    sites: s.alwaysOn,
    save: (alwaysOn) => opts.save({ alwaysOn }),
    toast: opts.toast,
  });
  rows.push(sites);
  // "Every site" but these: where the letters are the page's own (a game, an editor, a page with
  // a video playing in the background), the control is not there to take them.
  if (s.alwaysOn.length > 0) {
    const never = el(document, 'div', { class: 'speed-sites' });
    renderSiteList(never, {
      heading: 'But never on',
      empty: 'No exceptions. Its keys only work while there is a video or audio to control.',
      what: 'the speed control',
      sites: s.neverOn,
      save: (neverOn) => opts.save({ neverOn }),
      toast: opts.toast,
      exclusions: true,
    });
    rows.push(never);
  }

  // ---- what it does ----
  // A phone's only control is the button's − and +: its step is all it uses. Your speed, the
  // presets and rewinding are keys, set on a computer (they travel to it with Dropbox sync).
  if (phone) rows.push(labelledRow('Step', 'How much one tap of − or + moves the speed', stepPicker(s, opts)));
  else rows.push(...keysAndSpeeds(s, opts));

  // ---- how it behaves ----
  rows.push(
    labelledRow('Start videos at', 'Applied when a page’s video first appears', select(
      [{ value: '0', label: 'Whatever the site chose' }, ...rateOptions(s.presets, s.startAt)],
      String(s.startAt),
      (value) => void opts.save({ startAt: Number(value) }),
    )),
    checkboxRow('Remember the speed of each site', s.rememberPerSite, (on) => void opts.save({ rememberPerSite: on })),
    checkboxRow('Show the speed on the video when it changes', s.showBadge, (on) => void opts.save({ showBadge: on })),
  );
  // A phone always has the button: without it there is no way to change the speed there.
  if (!phone) {
    rows.push(checkboxRow(
      'Show a speed button on videos',
      s.showButton,
      (on) => void opts.save({ showButton: on }),
      'It appears when you move the mouse over a video. Click it for slower and faster, or drag it out of the way.',
    ));
  }
  rows.push(
    checkboxRow(
      'Stop videos and audio from playing by themselves',
      s.blockAutoplay,
      (on) => void opts.save({ blockAutoplay: on }),
      'On the sites above. Whatever you start yourself plays as usual.',
    ),
  );

  const actions = el(document, 'div', { class: 'speed-forget' });
  const forget = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Forget remembered site speeds');
  forget.addEventListener('click', async () => {
    // And where the speed button was moved on each site: both are "what Aloud remembers
    // about each site's videos", which the privacy policy says this clears.
    await Promise.all([clearSiteSpeeds(), clearTouchSpots()]);
    opts.toast('Site speeds forgotten');
  });
  actions.append(forget);
  if (!phone) {
    const reset = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Reset keys to defaults');
    reset.addEventListener('click', () => void opts.save({ keys: { ...DEFAULT_MEDIA_SPEED.keys } }));
    actions.append(reset);
  }
  rows.push(actions);

  host.replaceChildren(...rows);
  host.classList.toggle('is-off', !s.enabled);
}

/**
 * The keys, as tiles of a remote: an icon, a word or two, the key or keys, and the value they use.
 * Above them the speeds on one line, which is also where the presets are set: the presets as dots
 * (what the preset keys step through), 1×, and ★ at your speed (where G goes). Click the line to
 * add the speed under the pointer, a dot to take it out, or type one in "+".
 */
function keysAndSpeeds(s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLElement[] {
  const cap = (name: KeyName, what: string): HTMLButtonElement => keyButton(name, what, s, opts);
  const preferred = select(
    rateOptions(s.presets, s.preferred),
    String(s.preferred),
    (value) => void opts.save({ preferred: clampRate(Number(value)) }),
    'Your speed',
  );
  const seek = select(
    [5, 10, 15, 30].map((v) => ({ value: String(v), label: `${v} s` })),
    String(s.seekSeconds),
    (value) => void opts.save({ seekSeconds: Number(value) }),
    'Rewind and skip by',
  );
  const tiles = el(document, 'div', { class: 'km-tiles' });
  tiles.append(
    tile('step', ICONS.step(), 'Slower · faster', 'S and D: one step slower or faster', [cap('slower', 'Slower'), cap('faster', 'Faster')], stepPicker(s, opts)),
    tile('presets', ICONS.presets(), 'Presets', 'Down and up the dots on the line', [cap('previousPreset', 'Previous preset'), cap('nextPreset', 'Next preset')]),
    tile(
      'your-speed',
      ICONS.star(),
      'Your speed',
      'To ★, and back to 1×',
      [cap('preferred', 'Your speed')],
      preferred,
      // At 1× it has nowhere to jump: said here, or it looks like a dead key (#12).
      s.preferred === 1 ? 'Does nothing at 1×' : null,
    ),
    tile('normal', ICONS.normal(), 'Normal', 'Back to 1×', [cap('reset', 'Normal speed')]),
    tile('seek', ICONS.seek(), 'Back · forward', 'Even where the player has no seek bar', [cap('rewind', 'Rewind'), cap('advance', 'Skip forward')], seek),
    tile('mute', ICONS.mute(), 'Mute', 'Sound off, and on again', [cap('mute', 'Mute')]),
  );
  const panel = el(document, 'div', { class: 'keymap' });
  panel.append(speedLine(s, opts), tiles);
  return [
    el(document, 'p', { class: 'sub-label' }, 'While a page has a video or audio'),
    panel,
    el(document, 'p', { class: 'muted small speed-keys-hint' }, 'Click a key to change it. Click the line to add a speed, a dot to remove it.'),
  ];
}

/** A tile: icon and name (or "Press a key" while one of its keys waits), its keys, its value. */
function tile(act: string, icon: SVGSVGElement, name: string, tip: string, caps: HTMLButtonElement[], value: HTMLElement | null = null, note: string | null = null): HTMLElement {
  const box = el(document, 'div', { class: 'km-tile', 'data-act': act, title: tip });
  const head = el(document, 'div', { class: 'km-tile-head' });
  head.append(icon, el(document, 'span', { class: 'km-name' }, name), el(document, 'span', { class: 'km-prompt' }, 'Press a key'));
  const keys = el(document, 'div', { class: 'km-keys' });
  keys.append(...caps);
  box.append(head, keys);
  if (value) {
    const wrap = el(document, 'div', { class: 'km-tile-value' });
    wrap.append(value);
    box.append(wrap);
  }
  if (note) box.append(el(document, 'span', { class: 'km-note' }, note));
  return box;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
type Shape = [tag: string, attrs: Record<string, string>, text?: string];
function icon(...shapes: Shape[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('km-icon');
  for (const [tag, attrs, text] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text) node.textContent = text;
    svg.append(node);
  }
  return svg;
}
const filled = { fill: 'currentColor', stroke: 'none' };
const ICONS = {
  step: () => icon(['path', { d: 'M4.5 16.5a7.5 7.5 0 1 1 15 0' }], ['path', { d: 'M12 16.5l4-4.8' }], ['circle', { cx: '12', cy: '16.5', r: '1.7', ...filled }]),
  presets: () =>
    icon(['path', { d: 'M2.5 12h19' }], ['circle', { cx: '6', cy: '12', r: '2.3', ...filled }], ['circle', { cx: '12', cy: '12', r: '2.3', ...filled }], ['circle', { cx: '18', cy: '12', r: '2.3', ...filled }]),
  star: () => icon(['path', { d: 'M12 3.6l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.5l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z', ...filled }]),
  normal: () => icon(['rect', { x: '2.5', y: '6', width: '19', height: '12', rx: '4' }], ['text', { x: '12', y: '15.4', 'text-anchor': 'middle', 'font-size': '8.5', 'font-weight': '700', ...filled }, '1×']),
  seek: () => icon(['path', { d: 'M4 12a8 8 0 1 0 2.6-5.9' }], ['path', { d: 'M4 4.5v4h4' }]),
  mute: () => icon(['path', { d: 'M4 9.5h3.5L12 5.8v12.4l-4.5-3.7H4z', ...filled }], ['path', { d: 'M15.5 9.5l5 5M20.5 9.5l-5 5' }]),
};

/**
 * The speeds on one line, on a doubling scale (0.5× to 1× as long as 1× to 2×), and the place the
 * presets are set: each preset a dot that a click takes out (the last one stays), the line itself
 * adding the speed under the pointer (a ghost dot shows which, to the nearest quarter), "+" a
 * typed one. 1× is marked, and ★ is your speed. A label that would touch the one before it is
 * hidden once laid out, and again as the width changes (1×'s stays); its dot keeps it as a tooltip.
 */
function speedLine(s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLElement {
  const lo = 0.25;
  const hi = Math.max(4, ...s.presets, s.preferred);
  const span = Math.log2(hi) - Math.log2(lo);
  const at = (rate: number): number => ((Math.log2(rate) - Math.log2(lo)) / span) * 100;
  const rateAt = (percent: number): number => 2 ** (Math.log2(lo) + (percent / 100) * span);
  const save = (presets: number[]): void => void opts.save({ presets: [...new Set(presets.map(clampRate))].sort((a, b) => a - b) });

  const ruler = el(document, 'div', { class: 'km-ruler' });
  const line = el(document, 'div', { class: 'km-line' });
  const hit = el(document, 'div', { class: 'km-hit', title: 'Click to add this speed to the presets' });
  const ghost = el(document, 'span', { class: 'km-mark km-ghost', 'aria-hidden': 'true' });
  ghost.append(el(document, 'i', {}), el(document, 'b', {}));
  ghost.hidden = true;
  const under = (e: MouseEvent): number => {
    const box = hit.getBoundingClientRect();
    const percent = box.width > 0 ? Math.min(100, Math.max(0, ((e.clientX - box.left) / box.width) * 100)) : 50;
    return clampRate(Math.round(rateAt(percent) * 4) / 4);
  };
  hit.addEventListener('pointermove', (e) => {
    const rate = under(e);
    ghost.hidden = s.presets.includes(rate);
    ghost.style.left = `${at(rate)}%`;
    ghost.querySelector('b')!.textContent = `+${formatRate(rate)}`;
  });
  hit.addEventListener('pointerleave', () => (ghost.hidden = true));
  hit.addEventListener('click', (e) => {
    const rate = under(e);
    if (!s.presets.includes(rate)) save([...s.presets, rate]);
  });
  line.append(hit);

  for (const rate of [...new Set([...s.presets, 1])].sort((a, b) => a - b)) {
    const preset = s.presets.includes(rate);
    const last = preset && s.presets.length === 1;
    const mark = preset
      ? (el(document, 'button', {
          type: 'button',
          class: 'km-mark is-preset',
          title: last ? `${formatRate(rate)}: the last preset stays` : `${formatRate(rate)}: click to remove`,
          'aria-label': `Remove ${formatRate(rate)} from the presets`,
        }) as HTMLButtonElement)
      : el(document, 'span', { class: 'km-mark', title: formatRate(rate), 'aria-hidden': 'true' });
    mark.classList.toggle('is-one', rate === 1);
    mark.style.left = `${at(rate)}%`;
    mark.append(el(document, 'i', {}), el(document, 'b', {}, formatRate(rate)));
    if (mark instanceof HTMLButtonElement) {
      if (last) mark.disabled = true;
      else mark.addEventListener('click', () => save(s.presets.filter((p) => p !== rate)));
    }
    line.append(mark);
  }
  const star = el(document, 'span', { class: 'km-star', title: `Your speed: ${formatRate(s.preferred)}`, 'aria-hidden': 'true' }, '★');
  star.style.left = `${at(s.preferred)}%`;
  line.append(star, ghost);

  const add = el(document, 'input', {
    type: 'text',
    inputmode: 'decimal',
    class: 'preset-add',
    placeholder: '+',
    'aria-label': 'Add a preset speed',
    title: 'Type a speed, such as 1.75, and press Enter',
  }) as HTMLInputElement;
  // Enter fires "change" and leaving fires "blur": the first takes it, the second finds it empty.
  const commit = (): void => {
    const typed = add.value.trim().replace(',', '.').replace(/\s*[×x]$/i, '');
    add.value = '';
    const rate = Number(typed);
    if (!typed || !Number.isFinite(rate) || rate <= 0 || s.presets.includes(clampRate(rate))) return;
    save([...s.presets, rate]);
  };
  add.addEventListener('change', commit);
  add.addEventListener('blur', commit);

  ruler.append(line, add);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => thinLabels(line)).observe(line);
  return ruler;
}

/** Hides each label on the line that would touch one shown before it; 1×'s is shown first. */
function thinLabels(line: HTMLElement): void {
  const labels = [...line.querySelectorAll<HTMLElement>('.km-mark:not(.km-ghost) > b')];
  for (const label of labels) label.style.visibility = '';
  const one = line.querySelector<HTMLElement>('.km-mark.is-one > b');
  const kept: DOMRect[] = one ? [one.getBoundingClientRect()] : [];
  for (const label of labels) {
    if (label === one) continue;
    const box = label.getBoundingClientRect();
    if (kept.some((k) => box.left < k.right + 6 && box.right > k.left - 6)) label.style.visibility = 'hidden';
    else kept.push(box);
  }
}

function stepPicker(s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLSelectElement {
  return select(
    [0.05, 0.1, 0.25, 0.5].map((v) => ({ value: String(v), label: `±${v}×` })),
    String(s.step),
    (value) => void opts.save({ step: Number(value) }),
    'Step',
  );
}

/**
 * How the control is started, with the key it has now. Nothing below does anything on a page until
 * it is: the keys and speeds were taken for settings of the reading voice, and for broken (#12).
 */
function startHint(): HTMLElement {
  const hint = el(document, 'p', { class: 'muted small speed-start' }, 'It starts on a page when you press its shortcut there, and by itself on the sites listed here.');
  const say = (shortcut: string): void => {
    hint.replaceChildren(
      shortcut
        ? `It starts on a page when you press ${shortcut} there (again turns it off), and by itself on the sites listed here. `
        : 'It has no shortcut yet: give it one, or list the sites where it starts by itself. ',
      el(document, 'a', { href: '#shortcuts', 'data-view': 'shortcuts' }, shortcut ? 'Change the shortcut' : 'Shortcuts'),
    );
    // The link is made after the page wired its own (app-nav.ts): the address change shows the view.
  };
  void Promise.resolve(browser.commands?.getAll?.())
    .then((commands) => say(commands?.find((c) => c.name === 'media-speed')?.shortcut ?? ''))
    .catch(() => undefined);
  return hint;
}

/** A key as its keycap shows it: "⇧ D" for Shift + D; the full name is the button's label. */
function capLabel(binding: string): string {
  return formatBinding(binding).replace(/Shift \+ /g, '⇧ ').replace(/Cmd \+ /g, '⌘ ').replace(/ \+ /g, ' ');
}

/**
 * One key, as a keycap: clicked, it waits for the next key, pulsing, the same size, while its tile
 * says "Press a key". One waits at a time (key-recorder.ts): another key clicked, a click anywhere
 * else, or Esc, and it stops as it was. Backspace leaves the action without a key.
 */
function keyButton(name: KeyName, what: string, s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLButtonElement {
  const shown = capLabel(s.keys[name]);
  const button = el(document, 'button', { type: 'button', class: 'key-button km-cap', 'aria-label': `${what} key: ${formatBinding(s.keys[name])}` }, shown) as HTMLButtonElement;
  button.title = `${what}: click, then press the new key`;
  button.addEventListener('click', () => {
    if (stopIfRecording(button)) return;
    const box = button.closest('.km-tile');
    button.classList.add('listening');
    box?.classList.add('is-recording');
    let end = (): void => undefined;
    const done = (binding: string | null): void => {
      end();
      window.removeEventListener('keydown', onKey, true);
      button.classList.remove('listening');
      box?.classList.remove('is-recording');
      if (binding == null) {
        button.textContent = shown;
        return;
      }
      button.textContent = capLabel(binding);
      void opts.save({ keys: { ...s.keys, [name]: binding } });
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return done(null);
      if (e.key === 'Backspace') return done('');
      const combo = comboFromEvent(e);
      if (combo) done(combo);
    };
    end = beginRecording(button, () => done(null));
    window.addEventListener('keydown', onKey, true);
  });
  return button;
}

/**
 * Every quarter from 0.25× to 3×, then 3.5× to 5×, with the presets and `current` — a picker that
 * lacks the saved value shows its first option instead. (The presets and 1×, 1.5×, 2× alone left
 * out speeds such as 1.75×, which then could not be chosen.)
 */
function rateOptions(presets: readonly number[], current: number): Array<{ value: string; label: string }> {
  const quarters = Array.from({ length: 12 }, (_, i) => (i + 1) * 0.25);
  const rates = [...new Set([...quarters, 3.5, 4, 4.5, 5, ...presets, ...(current > 0 ? [current] : [])].map(clampRate))].sort((a, b) => a - b);
  return rates.map((r) => ({ value: String(r), label: formatRate(r) }));
}

function labelledRow(label: string, hint: string, control: HTMLElement): HTMLElement {
  const row = el(document, 'label', { class: 'row speed-row' });
  const text = el(document, 'span', { class: 'row-label' });
  text.append(el(document, 'span', {}, label), el(document, 'span', { class: 'muted small' }, hint));
  row.append(text, control);
  return row;
}

/**
 * On a phone: the speed button on every video, from one switch. A phone has no shortcut to start
 * the control on a page, so without this it only ran on sites listed one by one. It needs
 * access to every site, asked for here, from the tap itself (permissions.request must be).
 */
function everyVideoRow(s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLElement {
  const row = el(document, 'label', { class: 'row check' });
  const box = el(document, 'input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = s.alwaysOn.includes('*');
  const text = el(document, 'span', {}, 'Show the speed button on every video');
  text.append(el(document, 'span', { class: 'muted small check-hint' }, 'Tap it to go slower or faster. Your browser asks once to let Aloud work on every site.'));
  box.addEventListener('click', () => {
    const others = s.alwaysOn.filter((site) => site !== '*');
    if (!box.checked) {
      void opts.save({ alwaysOn: others });
      return;
    }
    void browser.permissions
      .request({ origins: ['*://*/*'] })
      .catch(() => false)
      .then(async (granted) => {
        if (!granted) {
          box.checked = false;
          opts.toast('Without that permission the button shows only on the sites listed below');
          return;
        }
        await opts.save({ alwaysOn: [...others, '*'] });
        opts.toast('The speed button now shows on every video');
      });
  });
  row.append(box, text);
  return row;
}

function checkboxRow(label: string, checked: boolean, onChange: (on: boolean) => void, hint?: string): HTMLElement {
  const row = el(document, 'label', { class: 'row check' });
  const box = el(document, 'input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  const text = el(document, 'span', {}, label);
  if (hint) text.append(el(document, 'span', { class: 'muted small check-hint' }, hint));
  row.append(box, text);
  return row;
}

function select(options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => void, label?: string): HTMLSelectElement {
  const picker = el(document, 'select', label ? { 'aria-label': label } : {}) as HTMLSelectElement;
  for (const option of options) picker.append(el(document, 'option', { value: option.value }, option.label));
  // Chosen once every option is in: marked on one before, some engines (happy-dom) pick another.
  if (options.some((o) => o.value === current)) picker.value = current;
  picker.addEventListener('change', () => onChange(picker.value));
  return picker;
}

/** How many sites have a remembered speed, for the settings page's hint. */
export async function rememberedSiteCount(): Promise<number> {
  return Object.keys(await loadSiteSpeeds()).length;
}
