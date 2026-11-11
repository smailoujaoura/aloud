/**
 * Settings that follow you to your other computers, through the browser's own sync (Firefox Sync,
 * Chrome sync), once you turn it on (Settings, Sync & backup).
 *
 * What travels is how you like to listen and read: speed and pauses, highlights, keys, the video
 * speed control, pronunciations, what to skip, the theme. What belongs to one device stays there:
 * - the engine and voices: each device downloads its own, and a phone and a computer with a
 *   graphics card are best served by different ones;
 * - the custom speech server: its permission is given per device;
 * - the sites given access ("Starts by itself on"): granted per device too, and a site listed
 *   without its permission would only look as though it worked;
 * - GPU and worker choices, debug logging, and this switch itself.
 *
 * storage.sync holds 100 KB in all and 8 KB an item. Each setting is an item of its own
 * (`s10.speed`, 10 being the settings version, so devices on different versions of the settings
 * never read each other's), and one too big for an item (a long pronunciation list) is cut into
 * pieces (`s10.pronunciations.1`, `.2`…) under a head carrying the hash of the whole. A setting
 * whose pieces have not all arrived from the other device yet is left as it is until they have.
 *
 * Per setting, against what both sides held when they last agreed:
 * - changed on one side only: that side's value;
 * - changed on both: the change just made here if this round was started by it, otherwise the
 *   synced one (two devices changed it before either had heard of the other);
 * - the first time it is turned on on a device: what the other devices synced, if they synced
 *   that setting; this device's own otherwise.
 *
 * Firefox for Android keeps storage.sync on the phone and never syncs it, so the switch is not
 * offered there (see the options page).
 */
import { storage } from 'wxt/utils/storage';
import { withStorageLock } from './storage-lock';
import { SETTINGS_VERSION, getSettings, sanitizeSettings, setSettings, withDefaults, type Settings } from './settings';

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
  'pdfView',
  'skipUrls',
  'expandAbbreviations',
  'tapToSeek',
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

/** Parts of a synced setting that stay on each device: the sites this browser was given access to. */
const DEVICE_PARTS: Partial<Record<SyncedSetting, readonly string[]>> = {
  mediaSpeed: ['alwaysOn'],
  annotate: ['alwaysOn'],
};

/** Under storage.sync's 8,192 bytes an item, its key included. */
const ITEM_BYTES = 7800;
/** A head naming more pieces than this is not one of ours. */
const MAX_PIECES = 64;

const prefix = (version = SETTINGS_VERSION): string => `s${version}.`;
const VERSIONED = /^s(\d+)\./;

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

/** JSON with every object's keys in order: the same value always gives the same text. */
export function canon(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** A short fingerprint of `text` (FNV-1a and the length): to tell a change, not to keep a secret. */
export function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

interface Head {
  /** When it was synced from the device that wrote it. */
  at: number;
  /** `hashOf(canon(value))`. */
  h: string;
  /** The value, when it fits in the head. */
  v?: unknown;
  /** Otherwise the number of pieces of its JSON text. */
  n?: number;
}

/** `text` in pieces that each fit an item. */
function cut(text: string, name: string): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let size = Math.min(text.length - at, ITEM_BYTES);
    let piece = text.slice(at, at + size);
    while (bytes(`${name}.${MAX_PIECES}`) + bytes(JSON.stringify(piece)) > ITEM_BYTES) {
      size = Math.floor(size * 0.8);
      piece = text.slice(at, at + size);
    }
    // Never between the two halves of a character outside the BMP.
    const last = piece.charCodeAt(piece.length - 1);
    if (piece.length > 1 && last >= 0xd800 && last <= 0xdbff) piece = piece.slice(0, -1);
    pieces.push(piece);
    at += piece.length;
  }
  return pieces;
}

/** The storage.sync items for one setting. */
export function encodeSetting(key: string, value: unknown, at: number): Record<string, unknown> {
  const text = canon(value);
  const name = prefix() + key;
  const head: Head = { at, h: hashOf(text), v: value };
  if (bytes(name) + bytes(JSON.stringify(head)) <= ITEM_BYTES) return { [name]: head };
  const pieces = cut(text, name);
  const items: Record<string, unknown> = { [name]: { at, h: head.h, n: pieces.length } satisfies Head };
  pieces.forEach((piece, i) => (items[`${name}.${i + 1}`] = piece));
  return items;
}

export interface Synced {
  at: number;
  h: string;
  value: unknown;
}

/** What storage.sync holds for this settings version: each setting, or `partial` while its pieces arrive. */
export function decodeSettings(all: Record<string, unknown>): Map<string, Synced | 'partial'> {
  const out = new Map<string, Synced | 'partial'>();
  const p = prefix();
  for (const [name, raw] of Object.entries(all)) {
    if (!name.startsWith(p)) continue;
    const key = name.slice(p.length);
    if (key.includes('.')) continue; // a piece, read with its head
    if (!raw || typeof raw !== 'object') continue;
    const head = raw as Head;
    if (typeof head.h !== 'string' || typeof head.at !== 'number') continue;
    if ('v' in head) {
      out.set(key, hashOf(canon(head.v)) === head.h ? { at: head.at, h: head.h, value: head.v } : 'partial');
      continue;
    }
    const n = head.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PIECES) continue;
    let text = '';
    for (let i = 1; i <= n; i++) {
      const piece = all[`${name}.${i}`];
      if (typeof piece !== 'string') {
        text = '';
        break;
      }
      text += piece;
    }
    if (!text || hashOf(text) !== head.h) {
      out.set(key, 'partial');
      continue;
    }
    try {
      out.set(key, { at: head.at, h: head.h, value: JSON.parse(text) });
    } catch {
      out.set(key, 'partial');
    }
  }
  return out;
}

/** Each side's hash of a setting when this device and the synced copy last agreed. */
export interface Agreed {
  l: string;
  r: string;
}

export interface SyncPlan {
  /** Settings to take from the synced copy, with that copy's hash. */
  take: Array<{ key: SyncedSetting; value: unknown; h: string }>;
  /** Settings to sync from here. */
  give: SyncedSetting[];
  /** The agreements that stand once `give` is written (`take`'s are settled after it is applied). */
  agreed: Record<string, Agreed>;
}

/**
 * What to take, what to give. `agreed` is null the first time on this device: everything synced
 * by another device is taken. `here` says the round was started by a change made on this device.
 */
export function planSync(
  local: Settings,
  remote: ReadonlyMap<string, Synced | 'partial'>,
  agreed: Readonly<Record<string, Agreed>> | null,
  here: boolean,
): SyncPlan {
  const plan: SyncPlan = { take: [], give: [], agreed: {} };
  for (const key of SYNCED_SETTINGS) {
    const hl = hashOf(canon(syncedValue(local, key)));
    const synced = remote.get(key);
    const before = agreed?.[key];
    if (synced === 'partial') {
      if (before) plan.agreed[key] = before;
      continue;
    }
    if (!synced) {
      plan.give.push(key);
      plan.agreed[key] = { l: hl, r: hl };
      continue;
    }
    if (synced.h === hl) {
      plan.agreed[key] = { l: hl, r: hl };
      continue;
    }
    if (!before) {
      plan.take.push({ key, value: synced.value, h: synced.h });
      continue;
    }
    const changedHere = hl !== before.l;
    const changedThere = synced.h !== before.r;
    if (!changedThere) {
      if (changedHere) {
        plan.give.push(key);
        plan.agreed[key] = { l: hl, r: hl };
      } else {
        // As they were when they last agreed (a value this device stores differently): leave it.
        plan.agreed[key] = before;
      }
    } else if (changedHere && here) {
      plan.give.push(key);
      plan.agreed[key] = { l: hl, r: hl };
    } else {
      plan.take.push({ key, value: synced.value, h: synced.h });
    }
  }
  return plan;
}

/** The storage area settings sync to: `browser.storage.sync` in the extension. */
export interface SyncArea {
  get(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface SyncStatus {
  at: number;
  /** The first round on this device took settings another device had synced. */
  took?: boolean;
  error?: string;
}

interface SyncBook {
  /** Sync was on at the last round (off → on is a first time). */
  on: boolean;
  /** The settings version `agreed` belongs to. */
  version: number;
  agreed: Record<string, Agreed>;
  status: SyncStatus | null;
}

const OFF: SyncBook = { on: false, version: 0, agreed: {}, status: null };
const book = storage.defineItem<SyncBook>('local:settingsSync', { fallback: OFF });

export async function loadSyncStatus(): Promise<SyncStatus | null> {
  return (await book.getValue()).status;
}

export function watchSyncStatus(cb: (status: SyncStatus | null) => void): () => void {
  return book.watch((value) => cb(value?.status ?? null));
}

function failure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /quota/i.test(message)
    ? "Too much to sync: the browser keeps 100 KB for each add-on's settings, and a very long pronunciation list can pass it."
    : `Could not sync: ${message}`;
}

/**
 * One round: compare this device's settings with the synced copy, take and give what changed.
 * Does nothing while the switch is off on this device.
 */
export async function runSettingsSync(area: SyncArea, reason: 'here' | 'there' | 'start', now = Date.now()): Promise<void> {
  await withStorageLock('settings-sync', async () => {
    const settings = await getSettings();
    const was = await book.getValue();
    if (!settings.syncSettings) {
      if (was.on || was.status) await book.setValue(OFF);
      return;
    }
    const first = !was.on || was.version !== SETTINGS_VERSION;
    let all: Record<string, unknown>;
    try {
      all = await area.get();
    } catch (err) {
      await book.setValue({ ...was, status: { at: now, error: failure(err) } });
      return;
    }
    const plan = planSync(settings, decodeSettings(all), first ? null : was.agreed, reason === 'here');

    let current = settings;
    if (plan.take.length > 0) {
      const patch: Partial<Settings> = {};
      for (const { key, value } of plan.take) (patch as Record<string, unknown>)[key] = withOwnParts(settings, key, value);
      // Through the same checks as a restored backup: whatever another version wrote, what is
      // stored here is a valid setting.
      const clean = sanitizeSettings(withDefaults({ ...settings, ...patch }));
      const changed: Partial<Settings> = {};
      for (const { key } of plan.take) {
        if (canon(syncedValue(clean, key)) !== canon(syncedValue(settings, key))) (changed as Record<string, unknown>)[key] = clean[key];
      }
      if (Object.keys(changed).length > 0) current = await setSettings(changed);
      for (const { key, h } of plan.take) plan.agreed[key] = { l: hashOf(canon(syncedValue(current, key))), r: h };
    }

    let error: string | undefined;
    if (plan.give.length > 0) {
      const items: Record<string, unknown> = {};
      for (const key of plan.give) Object.assign(items, encodeSetting(key, syncedValue(current, key), now));
      // Pieces a setting no longer has, and what versions of the settings two behind this one left.
      const stale = Object.keys(all).filter((name) => {
        if (name in items) return false;
        const version = Number(VERSIONED.exec(name)?.[1] ?? NaN);
        if (version < SETTINGS_VERSION - 1) return true;
        if (version !== SETTINGS_VERSION) return false;
        const [key = ''] = name.slice(prefix().length).split('.');
        return name.includes('.', prefix().length) && (plan.give as readonly string[]).includes(key);
      });
      try {
        await area.set(items);
        if (stale.length > 0) await area.remove(stale);
      } catch (err) {
        error = failure(err);
        // Not given after all: what stood before stands, so the next round tries again.
        for (const key of plan.give) {
          const before = first ? undefined : was.agreed[key];
          if (before) plan.agreed[key] = before;
          else delete plan.agreed[key];
        }
      }
    }

    const took = first && plan.take.length > 0;
    await book.setValue({
      on: true,
      version: SETTINGS_VERSION,
      agreed: plan.agreed,
      status: { at: now, ...(took ? { took: true } : {}), ...(error ? { error } : {}) },
    });
  });
}
