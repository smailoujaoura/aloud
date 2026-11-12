import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings';
import { SYNCED_SETTINGS, mergeSettings, settingsForSync, settingsToStore, syncedValue, type SyncedSettings } from '@/sync/synced-settings';

const with_ = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const entry = (v: unknown, at = 1) => ({ v, at });

describe('which settings travel', () => {
  it('voices, engine, server, GPU and debug stay on each device', () => {
    for (const key of ['engine', 'phononVoice', 'kokoroVoice', 'piperVoice', 'server', 'preferWebGPU', 'synthWorkers', 'languageVoices', 'debug']) {
      expect(SYNCED_SETTINGS as readonly string[]).not.toContain(key);
    }
  });

  it('so do the sites a device was given access to', () => {
    const s = with_({ mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['youtube.com'], neverOn: ['github.com'] } });
    expect(syncedValue(s, 'mediaSpeed')).not.toHaveProperty('alwaysOn');
    expect(syncedValue(s, 'mediaSpeed')).toMatchObject({ neverOn: ['github.com'] });
    expect(settingsForSync(s).mediaSpeed?.v).not.toHaveProperty('alwaysOn');
  });
});

describe('merging the file’s settings with this device’s', () => {
  const here = (speed: number): SyncedSettings => ({ speed: entry(speed, 0) });

  it('a device that just connected takes the settings the others use', () => {
    expect(mergeSettings({ speed: entry(1.5, 10) }, null, here(1), 99).speed).toEqual(entry(1.5, 10));
  });

  it('…but not defaults over what it changed: a fresh phone connected first must not reset a tuned computer', () => {
    const fileDefault = { speed: entry(DEFAULT_SETTINGS.speed, 10), theme: entry(DEFAULT_SETTINGS.theme, 10) };
    const tuned = { speed: entry(1.6, 0), theme: entry('dark', 0) };
    const merged = mergeSettings(fileDefault, null, tuned, 99);
    expect(merged.speed).toEqual(entry(1.6, 99));
    expect(merged.theme).toEqual(entry('dark', 99));
  });

  it('…and pronunciations from both are kept, the file’s winning for the same word', () => {
    const file = { pronunciations: entry([{ from: 'GIF', to: 'jif' }, { from: 'SQL', to: 'sequel' }], 10) };
    const mine = { pronunciations: entry([{ from: 'gif', to: 'gif' }, { from: 'nginx', to: 'engine x' }], 0) };
    const merged = mergeSettings(file, null, mine, 99).pronunciations!.v as Array<{ from: string; to: string }>;
    expect(merged.map((r) => `${r.from}=${r.to}`)).toEqual(['GIF=jif', 'SQL=sequel', 'nginx=engine x']);
  });

  it('…and gives the file any it does not have yet', () => {
    expect(mergeSettings({}, null, here(1.2), 99).speed).toEqual(entry(1.2, 99));
  });

  it('changed here only: ours, stamped now; changed there only: theirs', () => {
    const base = { speed: entry(1, 5) };
    expect(mergeSettings({ speed: entry(1, 5) }, base, here(1.3), 99).speed).toEqual(entry(1.3, 99));
    expect(mergeSettings({ speed: entry(1.7, 50) }, base, here(1), 99).speed).toEqual(entry(1.7, 50));
  });

  it('changed on both before either synced: this device’s, the later to sync', () => {
    expect(mergeSettings({ speed: entry(1.7, 50) }, { speed: entry(1, 5) }, here(1.3), 99).speed).toEqual(entry(1.3, 99));
  });
});

describe('storing what the file brought', () => {
  const sync = (s: Settings) => settingsForSync(s);

  it('takes the synced value and keeps this device’s own sites', () => {
    const now = with_({ speed: 1, mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['example.org'] } });
    const other = with_({ speed: 1.6, mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['youtube.com'], neverOn: ['github.com'] } });
    const patch = settingsToStore(now, sync(other), sync(now));
    expect(patch?.speed).toBe(1.6);
    expect(patch?.mediaSpeed?.neverOn).toEqual(['github.com']);
    expect(patch?.mediaSpeed?.alwaysOn).toEqual(['example.org']);
  });

  it('a setting changed here while the round ran stands', () => {
    const seen = with_({ speed: 1 });
    const now = with_({ speed: 1.25 });
    expect(settingsToStore(now, sync(with_({ speed: 1.6 })), sync(seen))).toBeNull();
  });

  it('nothing to change: null, so nothing is written', () => {
    const s = with_({ speed: 1.4 });
    expect(settingsToStore(s, sync(s), sync(s))).toBeNull();
  });

  it('a damaged group in the file never empties this device’s own sites', () => {
    const now = with_({ speed: 1, mediaSpeed: { ...DEFAULT_SETTINGS.mediaSpeed, alwaysOn: ['example.org'], step: 0.5 } });
    expect(settingsToStore(now, { ...sync(now), mediaSpeed: entry(null) }, sync(now))).toBeNull();
    expect(settingsToStore(now, { ...sync(now), mediaSpeed: entry([]) }, sync(now))).toBeNull();
  });

  it('PDF view and tap-to-jump stay on each device', () => {
    expect(SYNCED_SETTINGS as readonly string[]).not.toContain('pdfView');
    expect(SYNCED_SETTINGS as readonly string[]).not.toContain('tapToSeek');
  });

  it('a value no setting can have is put right, as a restored backup is', () => {
    const now = with_({});
    const patch = settingsToStore(now, { ...sync(now), wordStrength: entry('loud') }, sync(now));
    expect(patch === null || typeof patch.wordStrength === 'number').toBe(true);
  });
});
