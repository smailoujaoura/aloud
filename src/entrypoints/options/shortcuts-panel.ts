/**
 * The Shortcuts view: what each of Aloud's keys does, what it is set to right now, and — where
 * the browser allows it — changing it here.
 *
 * The keys are the browser's, not the page's: they work with no permission on any tab, which is
 * what makes "select text, press a key, it is kept" possible. Firefox lets an add-on set its own
 * (`commands.update`); Chromium only lets you do it on its own shortcuts page, so there this
 * reads out what is set and links to it.
 *
 * Defaults avoid `Alt+Shift+<letter>`: on Firefox that chord fires a web page's own accesskeys,
 * and the page was winning.
 */
import { browser } from 'wxt/browser';
import { el } from '@/shared/dom';

export interface ShortcutsPanelOptions {
  toast(message: string, kind?: 'info' | 'ok' | 'error'): void;
}

/** In the order they matter, with plainer words than the manifest's descriptions. */
const COMMANDS: Array<{ name: string; label: string; hint: string }> = [
  { name: 'toggle-read', label: 'Read this page aloud', hint: 'Start or stop reading, wherever you are' },
  { name: 'save-note', label: 'Keep the selection (or the sentence you just heard)', hint: 'With nothing selected and nothing reading, shows your notes' },
  { name: 'notes-panel', label: 'Show my notes on this page', hint: 'This page’s notes, or all of them' },
  { name: 'back-a-little', label: 'Back a little', hint: 'Replay the last few seconds' },
  { name: 'media-speed', label: 'Control this page’s video or audio speed', hint: 'Then D and S to change it' },
];

/** What `commands.update` accepts: Ctrl / Alt / Command / MacCtrl, optionally with Shift. */
const NAMED_KEYS: Record<string, string> = {
  Comma: 'Comma',
  Period: 'Period',
  Space: 'Space',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

/** A key press as the commands API spells it, or null when it cannot be a shortcut. */
export function commandShortcutFor(e: {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): string | null {
  const code = e.code ?? '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else key = NAMED_KEYS[code] ?? '';
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Command');
  if (e.shiftKey) mods.push('Shift');
  // Function keys may stand alone; everything else needs a real modifier, and Shift is not one.
  const hasRealModifier = mods.some((m) => m !== 'Shift');
  if (!hasRealModifier && !/^F([1-9]|1[0-2])$/.test(key)) return null;
  return [...mods, key].join('+');
}

/** "Alt+Comma" → "Alt + ," for reading. */
export function prettyShortcut(shortcut: string): string {
  if (!shortcut) return 'Not set';
  const pretty: Record<string, string> = { Comma: ',', Period: '.', Space: 'Space', Up: '↑', Down: '↓', Left: '←', Right: '→' };
  return shortcut
    .split('+')
    .map((part) => pretty[part] ?? part)
    .join(' + ');
}

export async function renderShortcutsPanel(host: HTMLElement, opts: ShortcutsPanelOptions): Promise<void> {
  const commands = await browser.commands?.getAll?.().catch(() => []);
  if (!commands) {
    host.replaceChildren(el(document, 'p', { class: 'muted' }, 'This browser does not give extensions keyboard shortcuts.'));
    return;
  }
  const update = (browser.commands as unknown as { update?: (d: { name: string; shortcut: string }) => Promise<void> }).update;
  const canSet = typeof update === 'function';
  const current = new Map(commands.map((c) => [c.name ?? '', c.shortcut ?? '']));

  const rows = COMMANDS.filter((c) => current.has(c.name)).map((c) => row(c, current.get(c.name) ?? '', canSet ? update : null, opts));
  const foot: HTMLElement[] = [];
  if (canSet) {
    const reset = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Reset to defaults');
    reset.addEventListener('click', async () => {
      const reset$ = (browser.commands as unknown as { reset?: (name: string) => Promise<void> }).reset;
      if (typeof reset$ !== 'function') return;
      for (const c of COMMANDS) await reset$(c.name).catch(() => undefined);
      opts.toast('Shortcuts back to their defaults', 'ok');
      void renderShortcutsPanel(host, opts);
    });
    foot.push(reset);
  } else {
    const open = el(document, 'button', { type: 'button', class: 'btn-sm' }, 'Change them in the browser');
    open.addEventListener('click', () => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => undefined));
    foot.push(
      el(document, 'p', { class: 'row-hint' }, 'This browser keeps extension shortcuts in its own settings; Aloud cannot change them for you.'),
      open,
    );
  }
  const keys = el(document, 'div', { class: 'speed-keys' });
  keys.append(...rows);
  host.replaceChildren(keys, ...foot);
}

function row(
  command: { name: string; label: string; hint: string },
  shortcut: string,
  update: ((d: { name: string; shortcut: string }) => Promise<void>) | null,
  opts: ShortcutsPanelOptions,
): HTMLElement {
  const wrap = el(document, 'div', { class: 'key-row' });
  const text = el(document, 'div', { class: 'key-text' });
  text.append(el(document, 'span', {}, command.label), el(document, 'span', { class: 'muted small' }, command.hint));

  const button = el(document, 'button', { type: 'button', class: 'key-button' }, prettyShortcut(shortcut)) as HTMLButtonElement;
  if (!update) {
    button.disabled = true;
    wrap.append(text, button);
    return wrap;
  }
  button.title = 'Click, then press the keys you want. Esc keeps it; Backspace clears it.';
  button.addEventListener('click', () => {
    button.classList.add('listening');
    button.textContent = 'Press keys…';
    const done = async (next: string | null): Promise<void> => {
      window.removeEventListener('keydown', onKey, true);
      button.classList.remove('listening');
      if (next == null) {
        button.textContent = prettyShortcut(shortcut);
        return;
      }
      try {
        await update({ name: command.name, shortcut: next });
        shortcut = next;
        button.textContent = prettyShortcut(next);
        opts.toast(next ? `${command.label}: ${prettyShortcut(next)}` : `${command.label}: no shortcut`, 'ok');
      } catch (err) {
        button.textContent = prettyShortcut(shortcut);
        opts.toast(`That key cannot be used: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return void done(null);
      if (e.key === 'Backspace') return void done('');
      const next = commandShortcutFor(e);
      if (next) void done(next);
    };
    window.addEventListener('keydown', onKey, true);
  });

  wrap.append(text, button);
  return wrap;
}
