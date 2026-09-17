/**
 * The settings page's video & audio speed section.
 *
 * Three parts: where the control runs (its shortcut, and the sites it starts on by itself), how
 * it behaves (step, presets, preferred and opening speed, memory, badge), and the keys — each
 * one set by pressing the key you want, since that is the only way to say "the key left of L" on
 * a keyboard that is not the author's.
 */
import { el } from '@/shared/dom';
import { browser } from 'wxt/browser';
import { clampRate, formatRate } from '@/media-speed/rate';
import { comboFromEvent, formatBinding } from '@/media-speed/keys';
import { clearSiteSpeeds, loadSiteSpeeds } from '@/media-speed/site-speeds';
import { DEFAULT_MEDIA_SPEED, type MediaSpeedSettings } from '@/shared/settings';

export interface MediaSpeedPanelOptions {
  settings: MediaSpeedSettings;
  save(patch: Partial<MediaSpeedSettings>): Promise<void>;
  toast(message: string): void;
}

const KEY_ROWS: Array<{ key: keyof MediaSpeedSettings['keys']; label: string; hint: string }> = [
  { key: 'faster', label: 'Faster', hint: 'One step up' },
  { key: 'slower', label: 'Slower', hint: 'One step down' },
  { key: 'reset', label: 'Normal speed', hint: 'Back to 1×' },
  { key: 'preferred', label: 'Your speed', hint: 'Jump to your preferred speed, and back' },
  { key: 'nextPreset', label: 'Next preset', hint: 'Up through the preset speeds' },
  { key: 'previousPreset', label: 'Previous preset', hint: 'Down through the preset speeds' },
];

export function renderMediaSpeedPanel(host: HTMLElement, opts: MediaSpeedPanelOptions): void {
  const s = opts.settings;
  const rows: HTMLElement[] = [];

  // ---- where it runs ----
  const sites = el(document, 'div', { class: 'speed-sites' });
  renderSites(sites, opts);
  rows.push(sites);

  // ---- how it behaves ----
  rows.push(
    labelledRow('Step', 'How much one press of faster or slower moves the speed', select(
      [0.05, 0.1, 0.25, 0.5].map((v) => ({ value: String(v), label: `${v}×` })),
      String(s.step),
      (value) => void opts.save({ step: Number(value) }),
    )),
    labelledRow('Your speed', 'The speed the “your speed” key jumps to', select(
      rateOptions(s.presets),
      String(s.preferred),
      (value) => void opts.save({ preferred: clampRate(Number(value)) }),
    )),
    labelledRow('Start videos at', 'Applied when a page’s video first appears', select(
      [{ value: '0', label: 'Whatever the site chose' }, ...rateOptions(s.presets)],
      String(s.startAt),
      (value) => void opts.save({ startAt: Number(value) }),
    )),
    presetsRow(s, opts),
    checkboxRow('Remember the speed of each site', s.rememberPerSite, (on) => void opts.save({ rememberPerSite: on })),
    checkboxRow('Show the speed on the video when it changes', s.showBadge, (on) => void opts.save({ showBadge: on })),
  );

  const forget = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Forget remembered site speeds');
  forget.addEventListener('click', async () => {
    await clearSiteSpeeds();
    opts.toast('Site speeds forgotten');
  });
  const forgetRow = el(document, 'div', { class: 'speed-forget' });
  forgetRow.append(forget);
  rows.push(forgetRow);

  // ---- the keys ----
  rows.push(el(document, 'p', { class: 'sub-label' }, 'Keys, while a page has a video or audio'));
  const keys = el(document, 'div', { class: 'speed-keys' });
  for (const row of KEY_ROWS) keys.append(keyRow(row, s, opts));
  rows.push(keys);

  const reset = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Reset keys to defaults');
  reset.addEventListener('click', () => void opts.save({ keys: { ...DEFAULT_MEDIA_SPEED.keys } }));
  const resetRow = el(document, 'div', { class: 'speed-forget' });
  resetRow.append(reset);
  rows.push(resetRow);

  host.replaceChildren(...rows);
  host.classList.toggle('is-off', !s.enabled);
}

/** The sites the control starts on by itself, each needing that site's permission. */
function renderSites(host: HTMLElement, opts: MediaSpeedPanelOptions): void {
  const { alwaysOn } = opts.settings;
  const head = el(document, 'p', { class: 'sub-label' }, 'Starts by itself on');
  const list = el(document, 'div', { class: 'site-chips' });

  if (alwaysOn.length === 0) {
    list.append(el(document, 'span', { class: 'muted small' }, 'No sites yet — the shortcut works everywhere without asking for anything.'));
  }
  for (const site of alwaysOn) {
    const chip = el(document, 'span', { class: 'site-chip' }, site === '*' ? 'Every site' : site);
    const remove = el(document, 'button', { type: 'button', class: 'chip-x', title: `Stop starting on ${site}`, 'aria-label': `Stop starting on ${site}` }, '✕');
    remove.addEventListener('click', async () => {
      await opts.save({ alwaysOn: alwaysOn.filter((a) => a !== site) });
      opts.toast(`Aloud no longer starts the speed control on ${site === '*' ? 'every site' : site}`);
    });
    chip.append(remove);
    list.append(chip);
  }

  const input = el(document, 'input', { type: 'text', placeholder: 'youtube.com', 'aria-label': 'Site to always control', class: 'site-input' }) as HTMLInputElement;
  const add = el(document, 'button', { type: 'button', class: 'btn-sm' }, 'Add site');
  const addAll = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Every site…');

  const grant = (host_: string): void => {
    const origins = host_ === '*' ? ['*://*/*'] : [`*://${host_}/*`, `*://*.${host_}/*`];
    // permissions.request must be called from the click itself, before anything is awaited.
    void browser.permissions
      .request({ origins })
      .catch(() => false)
      .then(async (granted) => {
        if (!granted) {
          opts.toast('Without permission for that site, use the shortcut instead');
          return;
        }
        if (!opts.settings.alwaysOn.includes(host_)) {
          await opts.save({ alwaysOn: [...opts.settings.alwaysOn, host_] });
        }
        opts.toast(host_ === '*' ? 'Speed control starts on every site' : `Speed control starts on ${host_}`);
      });
  };

  add.addEventListener('click', () => {
    const value = hostFrom(input.value);
    if (!value) {
      opts.toast('Type a site like youtube.com');
      return;
    }
    input.value = '';
    grant(value);
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') add.click();
  });
  addAll.addEventListener('click', () => grant('*'));

  const adder = el(document, 'div', { class: 'site-add' });
  adder.append(input, add, addAll);
  host.replaceChildren(head, list, adder);
}

function keyRow(
  row: { key: keyof MediaSpeedSettings['keys']; label: string; hint: string },
  s: MediaSpeedSettings,
  opts: MediaSpeedPanelOptions,
): HTMLElement {
  const wrap = el(document, 'div', { class: 'key-row' });
  const text = el(document, 'div', { class: 'key-text' });
  text.append(el(document, 'span', {}, row.label), el(document, 'span', { class: 'muted small' }, row.hint));

  const button = el(document, 'button', { type: 'button', class: 'key-button' }, formatBinding(s.keys[row.key])) as HTMLButtonElement;
  button.title = 'Click, then press the key you want. Esc keeps it as it is; Backspace clears it.';
  button.addEventListener('click', () => {
    button.classList.add('listening');
    button.textContent = 'Press a key…';
    const done = (binding: string | null): void => {
      window.removeEventListener('keydown', onKey, true);
      button.classList.remove('listening');
      if (binding == null) {
        button.textContent = formatBinding(s.keys[row.key]);
        return;
      }
      button.textContent = formatBinding(binding);
      void opts.save({ keys: { ...s.keys, [row.key]: binding } });
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

  wrap.append(text, button);
  return wrap;
}

function presetsRow(s: MediaSpeedSettings, opts: MediaSpeedPanelOptions): HTMLElement {
  const input = el(document, 'input', {
    type: 'text',
    class: 'presets-input',
    'aria-label': 'Preset speeds',
    value: s.presets.map((p) => String(p)).join(', '),
  }) as HTMLInputElement;
  const commit = (): void => {
    const presets = [...new Set(input.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0).map(clampRate))].sort((a, b) => a - b);
    if (presets.length === 0) {
      input.value = s.presets.join(', ');
      return;
    }
    input.value = presets.join(', ');
    void opts.save({ presets });
  };
  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  return labelledRow('Preset speeds', 'The speeds the preset keys step through', input);
}

function rateOptions(presets: readonly number[]): Array<{ value: string; label: string }> {
  const rates = [...new Set([...presets, 1, 1.5, 2])].sort((a, b) => a - b);
  return rates.map((r) => ({ value: String(r), label: formatRate(r) }));
}

function labelledRow(label: string, hint: string, control: HTMLElement): HTMLElement {
  const row = el(document, 'label', { class: 'row speed-row' });
  const text = el(document, 'span', { class: 'row-label' });
  text.append(el(document, 'span', {}, label), el(document, 'span', { class: 'muted small' }, hint));
  row.append(text, control);
  return row;
}

function checkboxRow(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const row = el(document, 'label', { class: 'row check' });
  const box = el(document, 'input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  row.append(box, el(document, 'span', {}, label));
  return row;
}

function select(options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => void): HTMLSelectElement {
  const picker = el(document, 'select', {}) as HTMLSelectElement;
  for (const option of options) {
    const node = el(document, 'option', { value: option.value }, option.label);
    if (option.value === current) node.selected = true;
    picker.append(node);
  }
  picker.addEventListener('change', () => onChange(picker.value));
  return picker;
}

/** "https://www.youtube.com/watch?v=1" or "YouTube.com " -> "youtube.com". */
export function hostFrom(input: string): string {
  const text = input.trim().toLowerCase();
  if (!text) return '';
  try {
    if (/^[a-z]+:\/\//.test(text)) return new URL(text).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
  const host = text.split('/')[0]!.replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : '';
}

/** How many sites have a remembered speed, for the settings page's hint. */
export async function rememberedSiteCount(): Promise<number> {
  return Object.keys(await loadSiteSpeeds()).length;
}
