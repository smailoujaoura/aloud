// @vitest-environment happy-dom
import { vi } from 'vitest';

vi.mock('wxt/utils/storage', () => ({ storage: { defineItem: () => ({}) } }));

import { describe, expect, it } from 'vitest';
import { pageKeyAction } from '@/annotate/annotator';

const keys = { keep: 'k', panel: 'n' };
const press = (key: string, extra: Record<string, unknown> = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, ...extra }) as never;

describe('pageKeyAction', () => {
  it('keeps the selection on K, and only with a selection', () => {
    expect(pageKeyAction(press('k'), keys, true)).toBe('keep');
    expect(pageKeyAction(press('K'), keys, true)).toBe('keep');
    expect(pageKeyAction(press('k'), keys, false)).toBeNull();
  });

  it('opens the notes panel on N, and only without a selection', () => {
    expect(pageKeyAction(press('n'), keys, false)).toBe('panel');
    expect(pageKeyAction(press('n'), keys, true)).toBeNull();
  });

  it('leaves typing alone', () => {
    const input = document.createElement('input');
    document.body.append(input);
    expect(pageKeyAction(press('k', { target: input }), keys, true)).toBeNull();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(editable);
    expect(pageKeyAction(press('n', { target: editable }), keys, false)).toBeNull();
  });

  it('leaves the browser’s own shortcuts alone', () => {
    expect(pageKeyAction(press('k', { ctrlKey: true }), keys, true)).toBeNull();
    expect(pageKeyAction(press('n', { altKey: true }), keys, false)).toBeNull();
    expect(pageKeyAction(press('k', { defaultPrevented: true }), keys, true)).toBeNull();
  });

  it('does nothing for a key that is switched off', () => {
    expect(pageKeyAction(press('k'), { keep: '', panel: 'n' }, true)).toBeNull();
    expect(pageKeyAction(press('j'), keys, true)).toBeNull();
  });
});

describe('typing inside a shadow root', () => {
  it('is typing, not a shortcut — the event retargets to the host', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    root.append(input);
    // What the browser delivers: target is the host, the real element is in the composed path.
    const event = {
      key: 'k',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      defaultPrevented: false,
      target: host,
      composedPath: () => [input, root, host, document.body, document],
    } as never;
    expect(pageKeyAction(event, { keep: 'k', panel: 'n' }, true)).toBeNull();
  });
});

describe('the notes panel key, by default', async () => {
  const { DEFAULT_ANNOTATE, migrateSettings } = await import('@/shared/settings');
  it('is off: a plain "n" belongs to the site (Gmail, X and others)', () => {
    expect(DEFAULT_ANNOTATE.pageKeys.panel).toBe('');
    expect(pageKeyAction(press('n'), DEFAULT_ANNOTATE.pageKeys, false)).toBeNull();
  });
  it('is switched off for profiles still on the old default, and kept where someone chose it', () => {
    const old = migrateSettings({ annotate: { pageKeys: { keep: 'k', panel: 'n' } } }, 6) as { annotate: { pageKeys: { panel: string } } };
    expect(old.annotate.pageKeys.panel).toBe('');
    const chosen = migrateSettings({ annotate: { pageKeys: { keep: 'k', panel: 'j' } } }, 6) as { annotate: { pageKeys: { panel: string } } };
    expect(chosen.annotate.pageKeys.panel).toBe('j');
  });
});
