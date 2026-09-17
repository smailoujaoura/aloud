/**
 * Key bindings for the media speed control, stored as text ("d", "shift+d", "alt+period").
 *
 * Bindings are matched on the *physical* key (`KeyboardEvent.code`) where there is one, so a
 * binding set on a QWERTY keyboard still works on AZERTY, and on layouts where a digit needs
 * Shift. Printable keys are stored by their letter or digit, arrows and punctuation by name.
 */

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;

const CODE_NAMES: Record<string, string> = {
  Space: 'space',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Semicolon: 'semicolon',
  Quote: 'quote',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
  Minus: 'minus',
  Equal: 'equal',
  Backquote: 'backquote',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Escape: 'escape',
  Enter: 'enter',
  Backspace: 'backspace',
  Delete: 'delete',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

/** The binding text for a key event, or '' for a modifier-only press. */
export function comboFromEvent(e: KeyboardEvent): string {
  const key = keyNameOf(e);
  if (!key) return '';
  const parts = MODIFIERS.filter((m) => modifierHeld(e, m));
  return [...parts, key].join('+');
}

export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  return binding !== '' && comboFromEvent(e) === normalizeBinding(binding);
}

/** Accepts what was stored (or typed): sorts modifiers and lower-cases everything. */
export function normalizeBinding(binding: string): string {
  const parts = binding
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.filter((p) => !MODIFIERS.includes(p as (typeof MODIFIERS)[number])).pop() ?? '';
  if (!key) return '';
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  return [...mods, key].join('+');
}

/** "Shift + D", "Alt + ." — how a binding is shown in the settings page. */
export function formatBinding(binding: string): string {
  const normalized = normalizeBinding(binding);
  if (!normalized) return 'None';
  const labels: Record<string, string> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Cmd',
    space: 'Space',
    comma: ',',
    period: '.',
    slash: '/',
    semicolon: ';',
    quote: "'",
    bracketleft: '[',
    bracketright: ']',
    backslash: '\\',
    minus: '−',
    equal: '=',
    backquote: '`',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    pageup: 'Page Up',
    pagedown: 'Page Down',
  };
  return normalized
    .split('+')
    .map((part) => labels[part] ?? part.toUpperCase())
    .join(' + ');
}

function modifierHeld(e: KeyboardEvent, modifier: (typeof MODIFIERS)[number]): boolean {
  if (modifier === 'ctrl') return e.ctrlKey;
  if (modifier === 'alt') return e.altKey;
  if (modifier === 'shift') return e.shiftKey;
  return e.metaKey;
}

function keyNameOf(e: KeyboardEvent): string {
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (CODE_NAMES[code]) return CODE_NAMES[code]!;
  // No usable code (synthetic events, some mobile keyboards): fall back to the character.
  const key = (e.key ?? '').toLowerCase();
  if (key.length === 1 && key !== ' ') return key;
  if (key === ' ') return 'space';
  if (key.startsWith('arrow')) return key.slice(5);
  return /^(escape|enter|backspace|delete|home|end|pageup|pagedown)$/.test(key) ? key : '';
}

/** True when the key belongs to whatever the user is typing into, not to us. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}
