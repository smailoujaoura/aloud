import { beforeEach, describe, expect, it } from 'vitest';
import { resetStorage } from './stubs/wxt-storage';
import { DEFAULT_SETTINGS, getSettings, setSettings, type Settings } from '@/shared/settings';
import {
  SYNCED_SETTINGS,
  canon,
  decodeSettings,
  encodeSetting,
  hashOf,
  loadSyncStatus,
  planSync,
  runSettingsSync,
  syncedValue,
  type SyncArea,
} from '@/shared/settings-sync';

/** storage.sync as the browser has it: values through JSON, Chrome's per-item limit enforced. */
function fakeSync(): SyncArea & { data: Map<string, unknown>; failNext?: Error } {
  const data = new Map<string, unknown>();
  const area = {
    data,
    failNext: undefined as Error | undefined,
    async get() {
      return Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
    },
    async set(items: Record<string, unknown>) {
      if (area.failNext) {
        const err = area.failNext;
        area.failNext = undefined;
        throw err;
      }
      for (const [k, v] of Object.entries(items)) {
        const size = new TextEncoder().encode(k + JSON.stringify(v)).length;
        if (size > 8192) throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded (${k}: ${size})`);
        data.set(k, JSON.parse(JSON.stringify(v)));
      }
    },
    async remove(keys: string[]) {
      for (const k of keys) data.delete(k);
    },
  };
  return area;
}

/** A device: its own local storage, from nothing, with these settings. */
async function device(patch: Partial<Settings>): Promise<void> {
  resetStorage();
  await setSettings({ syncSettings: true, ...patch });
}

const synced = (area: ReturnType<typeof fakeSync>, key: string): unknown => {
  const got = decodeSettings(Object.fromEntries(area.data)).get(key);
  return got && got !== 'partial' ? got.value : got;
};

/** A long pronunciation list, with quotes, accents and an emoji, too big for one item. */
const longList = Array.from({ length: 400 }, (_, i) => ({
  from: `naïve “word” ${i} 🙂`,
  to: `nah-EEV "word" ${i}`,
  caseSensitive: false,
  wholeWord: true,
}));

describe('settings in storage.sync', () => {
  it('a setting is one item, and comes back as it went', () => {
    const items = encodeSetting('speed', 1.35, 5);
    expect(Object.keys(items)).toEqual(['s10.speed']);
    expect(decodeSettings(items).get('speed')).toEqual({ at: 5, h: hashOf(canon(1.35)), value: 1.35 });
  });

  it('one too big for an item is cut into pieces that each fit, and joins up again', () => {
    const items = encodeSetting('pronunciations', longList, 7);
    const names = Object.keys(items);
    expect(names.length).toBeGreaterThan(3);
    for (const [name, value] of Object.entries(items)) {
      expect(new TextEncoder().encode(name + JSON.stringify(value)).length).toBeLessThanOrEqual(8192);
    }
    expect(decodeSettings(JSON.parse(JSON.stringify(items))).get('pronunciations')).toMatchObject({ value: longList });
  });

  it('while a piece has not arrived, the setting is partial, never half a value', () => {
    const items = encodeSetting('pronunciations', longList, 7);
    delete items['s10.pronunciations.2'];
    expect(decodeSettings(items).get('pronunciations')).toBe('partial');
  });

  it('what another version of the settings wrote is not read', () => {
    expect(decodeSettings({ 's9.speed': { at: 1, h: hashOf(canon(2)), v: 2 } }).size).toBe(0);
  });

  it('the sites a device was given access to stay on it', () => {
    const s = { ...DEFAULT_SETTINGS, mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['youtube.com'], neverOn: ['github.com'] } };
    expect(syncedValue(s, 'mediaSpeed')).not.toHaveProperty('alwaysOn');
    expect(syncedValue(s, 'mediaSpeed')).toMatchObject({ neverOn: ['github.com'] });
  });

  it('the voice, engine, server and GPU choices are never synced', () => {
    for (const key of ['engine', 'phononVoice', 'kokoroVoice', 'server', 'preferWebGPU', 'synthWorkers', 'languageVoices', 'debug', 'syncSettings']) {
      expect(SYNCED_SETTINGS as readonly string[]).not.toContain(key);
    }
  });
});

describe('what to take and what to give', () => {
  const local = { ...DEFAULT_SETTINGS, speed: 1.2 };
  const h = (v: unknown) => hashOf(canon(v));
  /** The synced copy: as this device has everything, but the speed. */
  const remote = (speed: number) =>
    new Map([
      ...SYNCED_SETTINGS.map((k) => [k, { at: 1, h: h(syncedValue(local, k)), value: syncedValue(local, k) }] as const),
      ['speed', { at: 1, h: h(speed), value: speed }] as const,
    ]);
  const agreedOn = (speed: number) => Object.fromEntries(SYNCED_SETTINGS.map((k) => [k, { l: h(syncedValue(local, k)), r: h(syncedValue(local, k)) }])) as Record<string, { l: string; r: string }> & { speed: { l: string; r: string } };

  it('the first time, what another device synced is taken; what nobody synced is given', () => {
    const plan = planSync(local, new Map([['speed', { at: 1, h: h(1.5), value: 1.5 }]]), null, true);
    expect(plan.take).toEqual([{ key: 'speed', value: 1.5, h: h(1.5) }]);
    expect(plan.give).toHaveLength(SYNCED_SETTINGS.length - 1);
  });

  it('changed there only: taken', () => {
    const agreed = { ...agreedOn(1.2), speed: { l: h(1.2), r: h(1.2) } };
    expect(planSync(local, remote(1.5), agreed, false).take.map((t) => t.key)).toEqual(['speed']);
  });

  it('changed here only: given', () => {
    const agreed = { ...agreedOn(1.2), speed: { l: h(1), r: h(1) } };
    const plan = planSync(local, remote(1), agreed, false);
    expect(plan.give).toEqual(['speed']);
    expect(plan.take).toEqual([]);
  });

  it('changed on both: the change just made here wins its own round, the synced one any other', () => {
    const agreed = { ...agreedOn(1.2), speed: { l: h(1), r: h(1) } };
    expect(planSync(local, remote(1.5), agreed, true).give).toEqual(['speed']);
    expect(planSync(local, remote(1.5), agreed, false).take.map((t) => t.key)).toEqual(['speed']);
  });

  it('a setting still arriving is left alone', () => {
    const plan = planSync(local, new Map([['speed', 'partial' as const]]), agreedOn(1.2), true);
    expect(plan.take).toEqual([]);
    expect(plan.give).not.toContain('speed');
  });
});

describe('two computers', () => {
  let area: ReturnType<typeof fakeSync>;
  beforeEach(() => {
    area = fakeSync();
  });

  it('the second one turned on takes the first one’s settings, and keeps its own sites and voice', async () => {
    await device({
      speed: 1.4,
      theme: 'dark',
      pronunciations: longList,
      engine: 'kokoro',
      mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['youtube.com'], neverOn: ['github.com'] },
    });
    await runSettingsSync(area, 'here', 100);
    expect(synced(area, 'speed')).toBe(1.4);
    expect(synced(area, 'engine')).toBeUndefined();

    await device({ speed: 1, engine: 'phonon', mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['example.org'] } });
    await runSettingsSync(area, 'start', 200);
    const s = await getSettings();
    expect(s.speed).toBe(1.4);
    expect(s.theme).toBe('dark');
    expect(s.pronunciations).toEqual(longList);
    expect(s.mediaSpeed.neverOn).toEqual(['github.com']);
    expect(s.mediaSpeed.alwaysOn).toEqual(['example.org']);
    expect(s.engine).toBe('phonon');
    expect(await loadSyncStatus()).toMatchObject({ at: 200, took: true });
  });

  it('a change on either side reaches the other, and a round with nothing new writes nothing', async () => {
    await device({ speed: 1.4 });
    await runSettingsSync(area, 'here', 100);

    // The other computer changes the speed.
    Object.entries(encodeSetting('speed', 2, 300)).forEach(([k, v]) => area.data.set(k, v));
    await runSettingsSync(area, 'there', 310);
    expect((await getSettings()).speed).toBe(2);
    expect(await loadSyncStatus()).not.toHaveProperty('took');

    // This one changes it back.
    await setSettings({ speed: 1.1 });
    await runSettingsSync(area, 'here', 400);
    expect(synced(area, 'speed')).toBe(1.1);

    const before = JSON.stringify([...area.data]);
    area.failNext = new Error('nothing should be written');
    await runSettingsSync(area, 'here', 500);
    expect(JSON.stringify([...area.data])).toBe(before);
    expect(await loadSyncStatus()).not.toHaveProperty('error');
  });

  it('a list that shrinks to one item leaves none of its old pieces behind', async () => {
    await device({ pronunciations: longList });
    await runSettingsSync(area, 'here', 100);
    expect([...area.data.keys()].some((k) => k.startsWith('s10.pronunciations.'))).toBe(true);
    await setSettings({ pronunciations: longList.slice(0, 2) });
    await runSettingsSync(area, 'here', 200);
    expect([...area.data.keys()].filter((k) => k.startsWith('s10.pronunciations'))).toEqual(['s10.pronunciations']);
    expect(synced(area, 'pronunciations')).toEqual(longList.slice(0, 2));
  });

  it('when the browser refuses the write, it says so and tries again next time', async () => {
    await device({ speed: 1.4 });
    area.failNext = new Error('QUOTA_BYTES quota exceeded');
    await runSettingsSync(area, 'here', 100);
    expect((await loadSyncStatus())?.error).toMatch(/^Too much to sync/);
    await runSettingsSync(area, 'here', 200);
    expect(synced(area, 'speed')).toBe(1.4);
    expect(await loadSyncStatus()).toEqual({ at: 200 });
  });

  it('off on this device: nothing is read or written, and the status is cleared', async () => {
    await device({ speed: 1.4 });
    await runSettingsSync(area, 'here', 100);
    await setSettings({ syncSettings: false, speed: 1.9 });
    await runSettingsSync(area, 'here', 200);
    expect(synced(area, 'speed')).toBe(1.4);
    expect(await loadSyncStatus()).toBeNull();
  });
});
