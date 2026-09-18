/**
 * A list of sites where something of Aloud's runs by itself — the speed control, highlights.
 *
 * Adding a site asks the browser for that site's permission, from the click itself; the
 * background registers the script only for sites that were actually granted. "Every site…" asks
 * for all of them at once, for people who want that.
 */
import { browser } from 'wxt/browser';
import { el } from '@/shared/dom';

export interface SiteListOptions {
  heading: string;
  /** Shown when the list is empty. */
  empty: string;
  /** What starts by itself, for messages: "the speed control", "your highlights". */
  what: string;
  sites: readonly string[];
  save(sites: string[]): Promise<void>;
  toast(message: string): void;
}

export function renderSiteList(host: HTMLElement, opts: SiteListOptions): void {
  const head = el(document, 'p', { class: 'sub-label' }, opts.heading);
  const list = el(document, 'div', { class: 'site-chips' });

  if (opts.sites.length === 0) list.append(el(document, 'span', { class: 'muted small' }, opts.empty));
  for (const site of opts.sites) {
    const label = site === '*' ? 'Every site' : site;
    const chip = el(document, 'span', { class: 'site-chip' }, label);
    const remove = el(document, 'button', { type: 'button', class: 'chip-x', title: `Remove ${label}`, 'aria-label': `Remove ${label}` }, '✕');
    remove.addEventListener('click', async () => {
      await opts.save(opts.sites.filter((a) => a !== site));
      opts.toast(`${capitalise(opts.what)} no longer starts on ${site === '*' ? 'every site' : site}`);
    });
    chip.append(remove);
    list.append(chip);
  }

  const input = el(document, 'input', { type: 'text', placeholder: 'doc.rust-lang.org', 'aria-label': 'Site to add', class: 'site-input' }) as HTMLInputElement;
  const add = el(document, 'button', { type: 'button', class: 'btn-sm' }, 'Add site');
  const addAll = el(document, 'button', { type: 'button', class: 'ghost btn-sm' }, 'Every site…');

  const grant = (site: string): void => {
    const origins = site === '*' ? ['*://*/*'] : [`*://${site}/*`, `*://*.${site}/*`];
    // permissions.request must be called from the click itself, before anything is awaited.
    void browser.permissions
      .request({ origins })
      .catch(() => false)
      .then(async (granted) => {
        if (!granted) {
          opts.toast('Without permission for that site, use the shortcut instead');
          return;
        }
        if (!opts.sites.includes(site)) await opts.save([...opts.sites, site]);
        opts.toast(`${capitalise(opts.what)} now starts on ${site === '*' ? 'every site' : site}`);
      });
  };

  add.addEventListener('click', () => {
    const value = hostFrom(input.value);
    if (!value) {
      opts.toast('Type a site like doc.rust-lang.org');
      return;
    }
    input.value = '';
    grant(value);
  });
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') add.click();
  });
  addAll.addEventListener('click', () => grant('*'));

  const adder = el(document, 'div', { class: 'site-add' });
  adder.append(input, add, addAll);
  host.replaceChildren(head, list, adder);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "https://www.youtube.com/watch?v=1" or "YouTube.com " -> "youtube.com". */
export function hostFrom(input: string): string {
  const text = input.trim().toLowerCase();
  if (!text) return '';
  try {
    if (/^[a-z]+:\/\//.test(text)) return new URL(text).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
  const host = text.split('/')[0]!.replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : '';
}
