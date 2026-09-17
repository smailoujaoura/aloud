/**
 * The speed each site was last watched at, so a site that is always watched at 1.75× opens there.
 *
 * Kept per host in `storage.local`, capped, and never synced — like everything else Aloud
 * remembers about what you read.
 */
import { storage } from 'wxt/utils/storage';

export type SiteSpeeds = Record<string, { rate: number; at: number }>;

export const MAX_SITES = 300;

export function withSiteSpeed(sites: SiteSpeeds, host: string, rate: number | null, now = Date.now()): SiteSpeeds {
  if (!host) return sites;
  if (rate == null) {
    const { [host]: _gone, ...rest } = sites;
    return rest;
  }
  const next: SiteSpeeds = { ...sites, [host]: { rate, at: now } };
  const hosts = Object.keys(next);
  if (hosts.length <= MAX_SITES) return next;
  const keep = new Set(hosts.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, MAX_SITES));
  return Object.fromEntries(Object.entries(next).filter(([h]) => keep.has(h)));
}

const item = storage.defineItem<SiteSpeeds>('local:mediaSpeedSites', { fallback: {} });

export async function loadSiteSpeeds(): Promise<SiteSpeeds> {
  try {
    return await item.getValue();
  } catch {
    return {};
  }
}

export async function rememberSiteSpeed(host: string, rate: number | null): Promise<void> {
  try {
    await item.setValue(withSiteSpeed(await loadSiteSpeeds(), host, rate));
  } catch {
    /* best-effort */
  }
}

export async function clearSiteSpeeds(): Promise<void> {
  await item.setValue({});
}

export function watchSiteSpeeds(cb: (sites: SiteSpeeds) => void): () => void {
  return item.watch((value) => cb(value ?? {}));
}
