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
  it('the reader and the video share S D R Z X for the same jobs, and nothing else', async () => {
    const { DEFAULT_READER_KEYS: r, DEFAULT_MEDIA_SPEED, DEFAULT_ANNOTATE } = await import('@/shared/settings');
    const m = DEFAULT_MEDIA_SPEED.keys;
    const reader = Object.values(r);
    expect(new Set(reader).size).toBe(reader.length);
    expect([r.slower, r.faster, r.normal, r.back, r.next]).toEqual([m.slower, m.faster, m.reset, m.rewind, m.advance]);
    const shared = new Set([m.slower, m.faster, m.reset, m.rewind, m.advance]);
    const video = Object.values(m).filter((k) => k.length === 1 && !shared.has(k));
    const notes = [DEFAULT_ANNOTATE.pageKeys.keep, DEFAULT_ANNOTATE.pageKeys.panel].filter(Boolean);
    expect(reader.filter((k) => video.includes(k) || notes.includes(k))).toEqual([]);
  });

  it('moves a profile on the old reader keys to the new ones, and keeps keys someone chose', async () => {
    const { migrateSettings } = await import('@/shared/settings');
    const old = { version: 9, readerKeys: { slower: '-', faster: '=', back: 'b', next: ']', playPause: 'p' } };
    expect(migrateSettings(old, 9).readerKeys).toMatchObject({ slower: 's', faster: 'd', back: 'z', next: 'x' });
    // A profile from before Hide moved off D: Hide moves to A, then D is free for faster.
    const older = { version: 9, readerKeys: { hide: 'd', faster: '=' } };
    expect(migrateSettings(older, 9).readerKeys).toMatchObject({ hide: 'a', faster: 'd' });
    const chosen = { version: 9, readerKeys: { slower: 'q', faster: '=', back: 'b', next: ']', playPause: 's' } };
    // "slower" was chosen, so it stays; the keys still on their old defaults move.
    expect(migrateSettings(chosen, 9).readerKeys).toMatchObject({ slower: 'q', playPause: 's', faster: 'd', back: 'z', next: 'x' });
  });
});
