// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { containTyping, typingInOwnField } from '@/ui/contain-typing';

describe('typing in a field inside a closed shadow root', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function editor(): { field: HTMLTextAreaElement; button: HTMLButtonElement; unhook: () => void } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'closed' });
    const field = document.createElement('textarea');
    const button = document.createElement('button');
    root.append(field, button);
    return { field, button, unhook: containTyping(root) };
  }

  it('is known to Aloud, though a window listener only sees the host', () => {
    // In a browser, a window listener's event path stops at the host of a closed root, so
    // isTypingEvent says no (happy-dom does not model that hiding, so it is not asserted here).
    // The reader keys therefore also ask the roots themselves.
    const { field, unhook } = editor();
    field.focus();
    expect(typingInOwnField()).toBe(true);
    unhook();
  });

  it('a focused button, or nothing focused, is not typing', () => {
    const { field, button, unhook } = editor();
    button.focus();
    expect(typingInOwnField()).toBe(false);
    field.focus();
    field.blur();
    expect(typingInOwnField()).toBe(false);
    unhook();
  });

  it('a removed editor is forgotten', () => {
    const { field, unhook } = editor();
    field.focus();
    unhook();
    expect(typingInOwnField()).toBe(false);
  });
});
