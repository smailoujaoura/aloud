import { describe, it, expect, vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { MAX_RATE, MIN_RATE, clampRate, formatRate, nextPreset, stepRate } from '@/media-speed/rate';
import { comboFromEvent, formatBinding, isTypingTarget, matchesBinding, normalizeBinding } from '@/media-speed/keys';
import { MAX_SITES, withSiteSpeed, type SiteSpeeds } from '@/media-speed/site-speeds';

/** A key event as the browser reports it, without needing a DOM. */
const key = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ code: '', key: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over }) as KeyboardEvent;

describe('rate arithmetic', () => {
  it('steps without binary dust and stops at the limits', () => {
    expect(stepRate(1.2, 0.1, 1)).toBe(1.3);
    expect(stepRate(1.3, 0.1, -1)).toBe(1.2);
    expect(stepRate(MAX_RATE, 0.5, 1)).toBe(MAX_RATE);
    expect(stepRate(MIN_RATE, 0.5, -1)).toBe(MIN_RATE);
    expect(clampRate(Number.NaN)).toBe(1);
  });

  it('steps through presets and stops at the ends', () => {
    const presets = [1, 1.5, 2];
    expect(nextPreset(1, presets, 1)).toBe(1.5);
    expect(nextPreset(1.6, presets, 1)).toBe(2);
    expect(nextPreset(2, presets, 1)).toBe(2); // already the fastest
    expect(nextPreset(1.5, presets, -1)).toBe(1);
    // Never wraps round: "slower" must not make it faster.
    expect(nextPreset(1, presets, -1)).toBe(1);
    expect(nextPreset(0.5, presets, -1)).toBe(1);
    expect(nextPreset(1, [], 1)).toBe(1);
  });

  it('shows rates the way people write them', () => {
    expect(formatRate(1)).toBe('1×');
    expect(formatRate(1.5)).toBe('1.5×');
    expect(formatRate(1.7500000001)).toBe('1.75×');
  });
});

describe('key bindings', () => {
  it('reads the physical key, so other layouts still match', () => {
    expect(comboFromEvent(key({ code: 'KeyD', key: 'd' }))).toBe('d');
    // French AZERTY: the key that says "D" reports code KeyD whatever it prints.
    expect(matchesBinding(key({ code: 'KeyD', key: 'δ' }), 'd')).toBe(true);
    expect(comboFromEvent(key({ code: 'Digit2', key: '"', shiftKey: true }))).toBe('shift+2');
  });

  it('orders modifiers the same way however a binding was written', () => {
    expect(normalizeBinding('Shift+Alt+D')).toBe('alt+shift+d');
    expect(matchesBinding(key({ code: 'KeyD', altKey: true, shiftKey: true }), 'shift+alt+d')).toBe(true);
    expect(matchesBinding(key({ code: 'KeyD' }), 'shift+d')).toBe(false);
    expect(matchesBinding(key({ code: 'KeyD' }), '')).toBe(false);
  });

  it('names keys with no character of their own', () => {
    expect(comboFromEvent(key({ code: 'ArrowUp' }))).toBe('up');
    expect(comboFromEvent(key({ code: 'Period', ctrlKey: true }))).toBe('ctrl+period');
    expect(comboFromEvent(key({ code: 'ShiftLeft', key: 'Shift' }))).toBe('');
  });

  it('formats bindings for the settings page', () => {
    expect(formatBinding('shift+d')).toBe('Shift + D');
    expect(formatBinding('alt+period')).toBe('Alt + .');
    expect(formatBinding('')).toBe('None');
  });

  it('leaves keys alone while someone is typing', () => {
    const input = { closest: (sel: string) => (sel.includes('input') ? {} : null), isContentEditable: false };
    expect(isTypingTarget(input as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ closest: () => null, isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ closest: () => null, isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('remembered site speeds', () => {
  it('stores, replaces and forgets a host', () => {
    let sites: SiteSpeeds = {};
    sites = withSiteSpeed(sites, 'youtube.com', 1.75, 10);
    expect(sites['youtube.com']).toEqual({ rate: 1.75, at: 10 });
    sites = withSiteSpeed(sites, 'youtube.com', 2, 20);
    expect(sites['youtube.com']!.rate).toBe(2);
    expect(withSiteSpeed(sites, 'youtube.com', null)).toEqual({});
    expect(withSiteSpeed(sites, '', 2)).toBe(sites);
  });

  it('keeps only the most recent hosts', () => {
    let sites: SiteSpeeds = {};
    for (let i = 0; i < MAX_SITES + 3; i++) sites = withSiteSpeed(sites, `h${i}.test`, 1.5, i);
    expect(Object.keys(sites)).toHaveLength(MAX_SITES);
    expect(sites['h0.test']).toBeUndefined();
    expect(sites[`h${MAX_SITES + 2}.test`]).toBeDefined();
  });
});
