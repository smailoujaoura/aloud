import { describe, expect, it } from 'vitest';
import { reservedUse } from '@/entrypoints/options/reserved-keys';
import { commandShortcutFor, prettyShortcut } from '@/entrypoints/options/shortcuts-panel';

describe('reservedUse', () => {
  it('knows the keys a browser answers itself', () => {
    expect(reservedUse('Alt+S', 'gecko')).toMatch(/History menu/);
    expect(reservedUse('Alt+S', 'blink')).toBeNull();
    expect(reservedUse('Ctrl+T', 'gecko')).toMatch(/new tab/);
    expect(reservedUse('Ctrl+T', 'blink')).toMatch(/new tab/);
  });

  it('flags the chord Firefox gives web pages', () => {
    expect(reservedUse('Alt+Shift+S', 'gecko')).toMatch(/access keys/);
    expect(reservedUse('Alt+Shift+S', 'blink')).toBeNull();
  });

  it('leaves Aloud’s own defaults alone', () => {
    for (const key of ['Alt+R', 'Alt+K', 'Alt+N', 'Alt+M', 'Alt+Comma']) {
      expect([key, reservedUse(key, 'gecko'), reservedUse(key, 'blink')]).toEqual([key, null, null]);
    }
  });
});

describe('commandShortcutFor', () => {
  it('spells a key press the way the commands API wants it', () => {
    expect(commandShortcutFor({ code: 'KeyK', altKey: true })).toBe('Alt+K');
    expect(commandShortcutFor({ code: 'Comma', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+Comma');
    expect(commandShortcutFor({ code: 'F4' })).toBe('F4');
  });

  it('refuses what cannot be a shortcut', () => {
    expect(commandShortcutFor({ code: 'KeyK' })).toBeNull();
    expect(commandShortcutFor({ code: 'KeyK', shiftKey: true })).toBeNull();
    expect(commandShortcutFor({ code: 'ShiftLeft', altKey: true })).toBeNull();
  });

  it('reads back in words', () => {
    expect(prettyShortcut('Alt+Comma')).toBe('Alt + ,');
    expect(prettyShortcut('')).toBe('Not set');
  });
});

describe('default single keys', () => {
  it('the reader, the note keys and the video keys never share one', async () => {
    const { DEFAULT_READER_KEYS, DEFAULT_MEDIA_SPEED, DEFAULT_ANNOTATE } = await import('@/shared/settings');
    const reader = Object.values(DEFAULT_READER_KEYS);
    const others = [...Object.values(DEFAULT_MEDIA_SPEED.keys), DEFAULT_ANNOTATE.pageKeys.keep, DEFAULT_ANNOTATE.pageKeys.panel].filter((k) => k && k.length === 1);
    expect(new Set(reader).size).toBe(reader.length);
    expect(reader.filter((k) => others.includes(k))).toEqual([]);
  });
});
