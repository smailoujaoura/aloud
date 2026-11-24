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
 * The keys, in one panel of three groups: the speed, moving through the video, the sound. Each row
 * is the key or keys, what they do, and the value they use, in columns that line up, so a key is
 * never read apart from its value (#12). Above the speed keys, the speeds on one line: the presets
 * the preset keys step through (dots), 1×, and your speed (★), where G goes.
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
    [5, 10, 15, 30].map((v) => ({ value: String(v), label: `${v} seconds` })),
    String(s.seekSeconds),
    (value) => void opts.save({ seekSeconds: Number(value) }),
    'Rewind and skip by',
  );
  const panel = el(document, 'div', { class: 'keymap' });
  panel.append(
    keyGroup(
      'Speed',
      speedRuler(s),
      keyRow('step', [cap('slower', 'Slower'), cap('faster', 'Faster')], 'Slower, faster', 'One step each press', stepPicker(s, opts)),
      keyRow('presets', [cap('previousPreset', 'Previous preset'), cap('nextPreset', 'Next preset')], 'Down, up the presets', 'The dots on the line above', null, presetChips(s, opts)),
      keyRow(
        'your-speed',
        [cap('preferred', 'Your speed')],
        'Your speed, and back to 1×',
        // At 1× it has nowhere to jump: said here, or it looks like a dead key (#12).
        s.preferred === 1 ? 'At 1× it has nowhere to go: choose another speed' : 'The ★ on the line above',
        preferred,
      ),
      keyRow('normal', [cap('reset', 'Normal speed')], 'Normal speed', 'Back to 1×'),
    ),
    keyGroup(
      'Moving through the video',
      null,
      keyRow('seek', [cap('rewind', 'Rewind'), cap('advance', 'Skip forward')], 'Back, forward', 'Even where the player has no seek bar', seek),
    ),
    keyGroup('Sound', null, keyRow('mute', [cap('mute', 'Mute')], 'Mute', 'Sound off, and on again')),
  );
  return [
    el(document, 'p', { class: 'sub-label' }, 'While a page has a video or audio'),
    panel,
    el(document, 'p', { class: 'muted small speed-keys-hint' }, 'To change a key, click it and press the new one. Esc keeps it as it is; Backspace leaves that action without a key.'),
  ];
}

function keyGroup(title: string, top: HTMLElement | null, ...rows: HTMLElement[]): HTMLElement {
  // Not a <section>: each one in a Settings view is drawn as a card of its own.
  const group = el(document, 'div', { class: 'km-group', role: 'group', 'aria-label': title });
  group.append(el(document, 'h4', { class: 'km-head' }, title));
  if (top) group.append(top);
  group.append(...rows);
  return group;
}

/** Key(s) | what they do | the value they use; `below` spans what and value (the preset chips). */
function keyRow(act: string, caps: HTMLElement[], title: string, hint: string, value: HTMLElement | null = null, below: HTMLElement | null = null): HTMLElement {
  const row = el(document, 'div', { class: 'km-row', 'data-act': act });
  const keys = el(document, 'div', { class: 'km-keys' });
  keys.append(...caps);
  const what = el(document, 'div', { class: 'km-what' });
  what.append(el(document, 'span', { class: 'km-title' }, title), el(document, 'span', { class: 'km-hint' }, hint));
  row.append(keys, what);
  if (value) {
    const box = el(document, 'div', { class: 'km-value' });
    box.append(value);
    row.append(box);
  }
  if (below) {
    const wide = el(document, 'div', { class: 'km-below' });
    wide.append(below);
    row.append(wide);
  }
  return row;
}

/**
 * The speeds on one line, as the keys move along it: the presets as dots (what the preset keys
 * step through), 1×, and ★ at your speed. On a doubling scale, so 0.5× to 1× is as long as 1× to
 * 2×. A label that would touch the one before it is hidden once laid out, and again as the width
 * changes (1×'s never: the others make way); the dot keeps it as its tooltip.
 */
function speedRuler(s: MediaSpeedSettings): HTMLElement {
  const lo = 0.25;
  const hi = Math.max(4, ...s.presets, s.preferred);
  const at = (rate: number): number => ((Math.log2(rate) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo))) * 100;
  const ruler = el(document, 'div', { class: 'km-ruler', 'aria-hidden': 'true' });
  const line = el(document, 'div', { class: 'km-line' });
  ruler.append(line);
  const rates = [...new Set([...s.presets, 1])].sort((a, b) => a - b);
  for (const rate of rates) {
    const where = at(rate);
    const mark = el(document, 'span', { class: 'km-mark', title: formatRate(rate) });
    mark.classList.toggle('is-preset', s.presets.includes(rate));
    mark.classList.toggle('is-one', rate === 1);
    mark.style.left = `${where}%`;
    mark.append(el(document, 'i', {}));
    mark.append(el(document, 'b', {}, formatRate(rate)));
    line.append(mark);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => thinLabels(line)).observe(line);
  const star = el(document, 'span', { class: 'km-star', title: `Your speed: ${formatRate(s.preferred)}` }, '★');
  star.style.left = `${at(s.preferred)}%`;
  line.append(star);
  return ruler;
}

/** Hides each ruler label that would touch the one shown before it; 1×'s is shown first. */
function thinLabels(line: HTMLElement): void {
  const labels = [...line.querySelectorAll<HTMLElement>('.km-mark > b')];
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
    [0.05, 0.1, 0.25, 0.5].map((v) => ({ value: String(v), label: `${v}×` })),
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

/** One key, as a button showing it: clicked, the next key pressed becomes it. */
function keyButton(name: KeyName, what: string, s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLButtonElement {
  const shown = capLabel(s.keys[name]);
  const button = el(document, 'button', { type: 'button', class: 'key-button km-cap', 'aria-label': `${what} key: ${formatBinding(s.keys[name])}` }, shown) as HTMLButtonElement;
  button.title = `${what}. Click, then press the key you want. Esc keeps it as it is; Backspace clears it.`;
  button.addEventListener('click', () => {
    button.classList.add('listening');
    // This text is also how the page knows a key is being recorded, and holds its redraws (main.ts).
    button.textContent = 'Press a key…';
    const done = (binding: string | null): void => {
      window.removeEventListener('keydown', onKey, true);
      button.classList.remove('listening');
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
    window.addEventListener('keydown', onKey, true);
  });
  return button;
}

/**
 * The preset speeds as chips, each with its ✕ (the last one stays: the keys need one to go to),
 * and a field to add one: typed, since any speed from 0.25× to 5× can be a preset.
 */
function presetChips(s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLElement {
  const wrap = el(document, 'span', { class: 'preset-chips' });
  const save = (presets: number[]): void => void opts.save({ presets: [...new Set(presets.map(clampRate))].sort((a, b) => a - b) });
  for (const rate of s.presets) {
    const chip = el(document, 'span', { class: 'site-chip preset-chip' }, formatRate(rate));
    if (s.presets.length > 1) {
      const remove = el(document, 'button', { type: 'button', class: 'chip-x', title: `Remove ${formatRate(rate)}`, 'aria-label': `Remove ${formatRate(rate)}` }, '✕');
      remove.addEventListener('click', () => save(s.presets.filter((p) => p !== rate)));
      chip.append(remove);
    }
    wrap.append(chip);
  }
  const add = el(document, 'input', {
    type: 'text',
    inputmode: 'decimal',
    class: 'preset-add',
    placeholder: '+ add',
    'aria-label': 'Add a preset speed',
    title: 'Type a speed, such as 1.75, and press Enter',
  }) as HTMLInputElement;
  // Enter fires "change" and leaving fires "blur": the first takes it, the second finds it empty.
  const commit = (): void => {
    const typed = add.value.trim().replace(',', '.').replace(/\s*[×x]$/i, '');
    add.value = '';
    const rate = Number(typed);
    if (!typed || !Number.isFinite(rate) || rate <= 0) return;
    if (s.presets.includes(clampRate(rate))) return;
    save([...s.presets, rate]);
  };
  add.addEventListener('change', commit);
  add.addEventListener('blur', commit);
  wrap.append(add);
  return wrap;
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
