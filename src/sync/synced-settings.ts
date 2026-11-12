/**
 * The settings that travel in the Dropbox file (sync/cloud-sync.ts), and how they are taken in.
 *
 * What travels is how you like to listen and read: speed and pauses, highlights, keys, the video
 * speed control, pronunciations, what to skip, the theme. What belongs to one device stays there:
 * - the engine and voices: each device downloads its own, and a phone and a computer with a
 *   graphics card are best served by different ones;
 * - the custom speech server: its permission is given per device;
 * - the sites given access ("Starts by itself on"): granted per device too, and a site listed
 *   without its permission would only look as though it worked;
 * - GPU and worker choices, debug logging;
 * - how PDFs are shown (pages or reflowed text) and tap-to-jump: one suits a phone, the other a
 *   computer.
 *
 * (1.0.4 first had these in the browser's own sync too. Most people are not signed in to their
 * browser, it cannot cross from Firefox to Chrome, and Firefox for Android never syncs add-on data,
 * so it went before release: one place, the reader's Dropbox, for everything.)
 */
import { canon } from '@/shared/three-way';
import { sanitizeSettings, withDefaults, type Settings } from '@/shared/settings';
import type { PronunciationRule } from '@/segment/pronunciations';

export const SYNCED_SETTINGS = [
  'speed',
  'sectionPauseMs',
  'sentencePauseMs',
  'highlight',
  'highlightColor',
  'wordHighlight',
  'wordColor',
  'wordStrength',
  'highlightReadable',
  'scrollMode',
  'skipUrls',
  'expandAbbreviations',
  'pronunciations',
  'skip',
  'readerKeys',
  'mediaSpeed',
  'annotate',
  'barAutoHide',
  'theme',
  'tipsSeen',
] as const satisfies readonly (keyof Settings)[];

export type SyncedSetting = (typeof SYNCED_SETTINGS)[number];

const SYNCED = new Set<string>(SYNCED_SETTINGS);
export const isSyncedSetting = (key: string): key is SyncedSetting => SYNCED.has(key);

/** Parts of a synced setting that stay on each device: the sites this browser was given access to. */
const DEVICE_PARTS: Partial<Record<SyncedSetting, readonly string[]>> = {
  mediaSpeed: ['alwaysOn'],
  annotate: ['alwaysOn'],
};

/** What one setting is, as synced: without the parts that stay on each device. */
export function syncedValue(settings: Settings, key: SyncedSetting): unknown {
  const value = settings[key];
  const own = DEVICE_PARTS[key];
  if (!own || !value || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) };
  for (const part of own) delete copy[part];
  return copy;
}

/** A synced value as this device stores it: with its own parts put back. */
function withOwnParts(settings: Settings, key: SyncedSetting, incoming: unknown): unknown {
  const own = DEVICE_PARTS[key];
  if (!own || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const here = settings[key] as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(incoming as Record<string, unknown>) };
  for (const part of own) merged[part] = here[part];
  return merged;
}

/** One synced setting in the file: its value, and when a device last changed it. */
export interface SyncedSettingEntry {
  v: unknown;
  at: number;
}
export type SyncedSettings = Record<string, SyncedSettingEntry>;

/** This device's synced settings, for the file (`at` is settled when merged). */
export function settingsForSync(settings: Settings): SyncedSettings {
  return Object.fromEntries(SYNCED_SETTINGS.map((key) => [key, { v: syncedValue(settings, key), at: 0 }]));
}

const same = (a: SyncedSettingEntry | undefined, b: SyncedSettingEntry | undefined): boolean => !!a && !!b && canon(a.v) === canon(b.v);

let defaults: Settings | null = null;
const isDefault = (key: string, value: unknown): boolean =>
  isSyncedSetting(key) && canon(value) === canon(syncedValue((defaults ??= withDefaults({})), key));

/** A rule, by what it matches: the same word in the same case and language. */
const ruleKey = (rule: PronunciationRule): string => `${rule.matchCase ? rule.from : rule.from.toLowerCase()}\u0000${rule.matchCase ? 1 : 0}\u0000${rule.language ?? ''}`;

/**
 * A device joining (no settings agreed with the file yet) with a value that differs from the
 * file's. Where the file still has the default and this device changed it, this device's: a fresh
 * phone that connected first must not reset a tuned computer. Pronunciations from both, the
 * file's winning for the same word. Otherwise the file's, the settings the others use.
 */
function join(key: string, there: SyncedSettingEntry, here: SyncedSettingEntry, now: number): SyncedSettingEntry {
  if (key === 'pronunciations' && Array.isArray(there.v) && Array.isArray(here.v)) {
    const known = new Set((there.v as PronunciationRule[]).map(ruleKey));
    const added = (here.v as PronunciationRule[]).filter((rule) => rule && typeof rule.from === 'string' && !known.has(ruleKey(rule)));
    return added.length > 0 ? { v: [...there.v, ...added], at: now } : there;
  }
  if (isDefault(key, there.v) && !isDefault(key, here.v)) return { v: here.v, at: now };
  return there;
}

/**
 * One setting list from the file's (`latest`), this device's (`current`) and the last agreed
 * (`baseline`), per setting:
 * - changed on one side only: that side's;
 * - changed on both before either synced: this device's, the later to sync;
 * - no baseline (this device just connected): see `join`; this device's for any the file does not
 *   have yet.
 */
export function mergeSettings(latest: SyncedSettings, baseline: SyncedSettings | null, current: SyncedSettings, now: number): SyncedSettings {
  const out: SyncedSettings = {};
  for (const key of new Set([...Object.keys(latest), ...Object.keys(current)])) {
    const there = latest[key];
    const here = current[key];
    if (!here) {
      if (there) out[key] = there;
      continue;
    }
    if (!there) {
      out[key] = { v: here.v, at: now };
      continue;
    }
    if (same(here, there)) {
      out[key] = there;
      continue;
    }
    if (!baseline) {
      out[key] = join(key, there, here, now);
      continue;
    }
    const before = baseline[key];
    out[key] = !same(here, before) ? { v: here.v, at: now } : there;
  }
  return out;
}

/**
 * What to store on this device for `merged`, given `seen` (this device's settings when the round
 * began) and `now` (as they are at this moment): a setting changed here while the round ran is
 * kept. Returns null when nothing changes. Passed through the same checks as a restored backup, so
 * whatever another version of Aloud wrote, a valid setting is stored.
 */
export function settingsToStore(now: Settings, merged: SyncedSettings, seen: SyncedSettings): Partial<Settings> | null {
  const patch: Record<string, unknown> = {};
  for (const key of SYNCED_SETTINGS) {
    const entry = merged[key];
    if (!entry) continue;
    // A group with a part of its own on this device (its sites) must arrive as a group: anything
    // else (a damaged file) would come out of the checks as defaults, its site list empty.
    if (DEVICE_PARTS[key] && (!entry.v || typeof entry.v !== 'object' || Array.isArray(entry.v))) continue;
    const here = syncedValue(now, key);
    if (seen[key] && canon(here) !== canon(seen[key]!.v)) continue; // changed here meanwhile: ours stands
    if (canon(here) === canon(entry.v)) continue;
    patch[key] = withOwnParts(now, key, entry.v);
  }
  const keys = Object.keys(patch) as SyncedSetting[];
  if (keys.length === 0) return null;
  const clean = sanitizeSettings(withDefaults({ ...now, ...(patch as Partial<Settings>) }));
  const changed: Record<string, unknown> = {};
  for (const key of keys) if (canon(syncedValue(clean, key)) !== canon(syncedValue(now, key))) changed[key] = clean[key];
  return Object.keys(changed).length > 0 ? (changed as Partial<Settings>) : null;
}
