/**
 * Settings, Sync & backup: notes and PDF highlights in the reader's own Dropbox (sync/).
 *
 * On a computer, Connect opens Dropbox's sign-in and the browser hands the answer straight back
 * (identity.launchWebAuthFlow). Firefox for Android has no identity API, so there Dropbox shows a
 * code, and the reader pastes it here.
 */
import { browser } from 'wxt/browser';
import { el } from '@/shared/dom';
import { authorizeUrl, pkcePair } from '@/sync/dropbox';
import { loadCloudStatus, watchCloudStatus, type CloudStatus } from '@/sync/cloud-sync';
import {
  SYNC_DATA_CONSENT,
  connectDropbox,
  describeSyncError,
  disconnectDropbox,
  dropboxAuth,
  pendingSignIn,
  setPendingSignIn,
  syncWithDropbox,
  watchDropboxAuth,
} from '@/sync/dropbox-sync';
import type { DropboxAuth } from '@/sync/dropbox';

export interface DropboxPanelOptions {
  toast(message: string, kind?: 'error'): void;
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Firefox asks the reader to agree to notes leaving the browser; from the click, before anything is awaited. */
function askConsent(): Promise<boolean> {
  if (import.meta.env.BROWSER !== 'firefox') return Promise.resolve(true);
  try {
    return browser.permissions.request({ data_collection: SYNC_DATA_CONSENT } as never).catch(() => true);
  } catch {
    return Promise.resolve(true); // a Firefox without data-collection permissions
  }
}

export function renderDropboxPanel(host: HTMLElement, opts: DropboxPanelOptions): void {
  const doc = host.ownerDocument;
  const title = el(doc, 'p', { class: 'sync-title' }, 'Your notes, settings and reading, in your Dropbox');
  const about = el(
    doc,
    'p',
    { class: 'muted small' },
    'One file in your own Dropbox (Apps/Aloud-tts/aloud.json), merged on every device you connect, phones included: your notes and PDF highlights; your settings (reading speed and pauses, highlights, keys, video speed, pronunciations, what to skip, the theme); where you stopped in each page and what you listened to, so another device picks up there. Each device keeps its own voices and the sites you gave access to. A device you connect takes the settings the others use. It goes to your Dropbox and nowhere else.',
  );
  const who = el(doc, 'p', { class: 'small' });
  const status = el(doc, 'p', { class: 'row-hint flush', role: 'status' });
  const actions = el(doc, 'div', { class: 'sync-actions' });
  const connectBtn = el(doc, 'button', { type: 'button', class: 'primary' }, 'Connect Dropbox');
  const syncBtn = el(doc, 'button', { type: 'button' }, 'Sync now');
  const disconnectBtn = el(doc, 'button', { type: 'button' }, 'Disconnect');

  // The phone's step: the code Dropbox shows.
  const codeStep = el(doc, 'div', { class: 'sync-code', hidden: '' });
  const codeHelp = el(doc, 'p', { class: 'small' }, 'Dropbox opened in a new tab. Allow Aloud there, copy the code it shows, and paste it here:');
  const codeInput = el(doc, 'input', { type: 'text', placeholder: 'Code from Dropbox', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Code from Dropbox' });
  const codeBtn = el(doc, 'button', { type: 'button', class: 'primary' }, 'Connect');
  codeStep.append(codeHelp, codeInput, codeBtn);

  actions.append(disconnectBtn, syncBtn, connectBtn);
  host.append(title, about, who, actions, codeStep, status);

  let auth: DropboxAuth | null = null;
  let last: CloudStatus | null = null;

  const draw = (): void => {
    connectBtn.hidden = !!auth;
    syncBtn.hidden = disconnectBtn.hidden = !auth;
    if (auth) codeStep.hidden = true;
    who.hidden = !auth;
    who.textContent = auth ? (auth.who ? `Connected to Dropbox as ${auth.who}.` : 'Connected to Dropbox.') : '';
    status.classList.toggle('warn', !!(auth && last?.error));
    if (!auth) status.textContent = '';
    else if (last?.error) status.textContent = last.error;
    else if (last) {
      const time = new Date(last.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const pdfs = last.pdfs ? `, highlights in ${plural(last.pdfs, 'PDF', 'PDFs')}` : '';
      const places = last.places ? `, your place in ${plural(last.places, 'page', 'pages')}` : '';
      status.textContent = `Synced at ${time}: ${plural(last.notes ?? 0, 'note', 'notes')}${pdfs}${places}.`;
    } else status.textContent = 'Syncing…';
  };

  const connected = async (code: string, verifier: string, redirect: string | undefined): Promise<void> => {
    await connectDropbox(code, verifier, redirect);
    opts.toast('Connected to Dropbox. Your notes are syncing.');
  };

  connectBtn.addEventListener('click', () => {
    const consent = askConsent();
    void (async () => {
      if (!(await consent)) {
        opts.toast("Not connected: Firefox's permission to send your notes to your Dropbox is needed.", 'error');
        return;
      }
      const { verifier, challenge } = await pkcePair();
      const identity = browser.identity as typeof browser.identity | undefined;
      if (identity?.launchWebAuthFlow) {
        const redirect = identity.getRedirectURL();
        const state = crypto.randomUUID();
        let back: string | undefined;
        try {
          back = await identity.launchWebAuthFlow({ url: authorizeUrl(challenge, redirect, state), interactive: true });
        } catch {
          opts.toast('Not connected to Dropbox.');
          return;
        }
        const answer = new URL(back ?? 'about:blank');
        const code = answer.searchParams.get('code');
        if (answer.searchParams.get('state') !== state || !code) {
          opts.toast(answer.searchParams.get('error_description') ?? 'Not connected to Dropbox.', 'error');
          return;
        }
        await connected(code, verifier, redirect);
      } else {
        await setPendingSignIn(verifier);
        await browser.tabs.create({ url: authorizeUrl(challenge) });
        codeStep.hidden = false;
        codeInput.focus();
      }
    })().catch((err) => opts.toast(`Could not connect to Dropbox: ${describeSyncError(err)}`, 'error'));
  });

  codeBtn.addEventListener('click', () => {
    void (async () => {
      const code = codeInput.value.trim();
      const verifier = await pendingSignIn();
      if (!code) return;
      if (!verifier) {
        opts.toast('That sign-in is too old. Press Connect Dropbox again.', 'error');
        codeStep.hidden = true;
        return;
      }
      codeBtn.disabled = true;
      try {
        await connected(code, verifier, undefined);
        codeInput.value = '';
      } finally {
        codeBtn.disabled = false;
      }
    })().catch((err) => opts.toast(`Could not connect to Dropbox: ${describeSyncError(err)}`, 'error'));
  });

  syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    status.classList.remove('warn');
    status.textContent = 'Syncing…';
    void syncWithDropbox('other').finally(() => {
      syncBtn.disabled = false;
      void loadCloudStatus().then((s) => {
        last = s;
        draw();
      });
    });
  });

  disconnectBtn.addEventListener('click', () => {
    void disconnectDropbox()
      .then(() => opts.toast('Disconnected. Your notes stay on this device and in your Dropbox.'))
      .catch((err) => opts.toast(String(err), 'error'));
  });

  void Promise.all([dropboxAuth.get(), loadCloudStatus(), pendingSignIn()]).then(([a, s, pending]) => {
    auth = a;
    last = s;
    // A phone that left this page for Dropbox's tab comes back to the code step.
    if (!a && pending) codeStep.hidden = false;
    draw();
    // Opening Settings is a good moment to fetch what other devices wrote.
    if (a) void syncWithDropbox('other');
  });
  watchDropboxAuth((a) => {
    auth = a;
    draw();
  });
  watchCloudStatus((s) => {
    last = s;
    draw();
  });
}
