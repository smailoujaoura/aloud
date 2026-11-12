/**
 * Dropbox, as Aloud uses it: one file in the app's own folder of the reader's Dropbox.
 *
 * The app ("Aloud-tts" in Dropbox's developer console) has App folder access: it sees
 * Apps/Aloud-tts and nothing else in the reader's Dropbox. Sign-in is OAuth with PKCE, which needs
 * no app secret: the app key below is public by design. Dropbox's API answers extension origins
 * with CORS headers (checked for chrome-extension:// and moz-extension://, Dropbox-API-Result
 * exposed), so no access to dropbox.com is asked for.
 *
 * Every call goes through `fetchFn` so the tests can stand in for Dropbox.
 */

export const DROPBOX_APP_KEY = 't6xdm45fv5o1qx4';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

/** The reader's connection, kept in storage.local, never in a backup. */
export interface DropboxAuth {
  refresh: string;
  access: string;
  /** When `access` stops working (ms since the epoch), a minute early. */
  expiresAt: number;
  accountId: string;
  /** Who it is, to show in Settings: "Sam Lee (sam@example.org)". */
  who?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How long one request to Dropbox may take. A round holds the sync lock while it waits, so a
 * connection that dies mid-request (a laptop put to sleep) must not hold every later round up.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
const timeout = (): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;

export class DropboxError extends Error {
  constructor(
    readonly status: number,
    readonly summary: string,
  ) {
    super(`Dropbox: ${status} ${summary}`);
  }
}

function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * Dropbox's page asking the reader to let Aloud use its folder. Without `redirectUri` Dropbox shows
 * a code to copy into Aloud instead of sending the browser back (Firefox for Android, which has
 * no identity API to catch the redirect).
 */
export function authorizeUrl(challenge: string, redirectUri?: string, state?: string): string {
  const params = new URLSearchParams({
    client_id: DROPBOX_APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // A refresh token: the connection lasts until the reader disconnects, not four hours.
    token_access_type: 'offline',
  });
  if (redirectUri) params.set('redirect_uri', redirectUri);
  if (state) params.set('state', state);
  return `${AUTHORIZE_URL}?${params}`;
}

async function tokenCall(body: Record<string, string>, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: timeout(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Both, so the cause can be told: a revoked connection is `invalid_grant`, with a description.
    const code = typeof data.error === 'string' ? data.error : '';
    const detail = typeof data.error_description === 'string' ? data.error_description : '';
    throw new DropboxError(res.status, [code, detail].filter(Boolean).join(': ') || res.statusText);
  }
  return data;
}

function expiry(data: Record<string, unknown>, now: number): number {
  const seconds = typeof data.expires_in === 'number' ? data.expires_in : 14400;
  return now + Math.max(60, seconds - 60) * 1000;
}

/** The code Dropbox gave back (or showed), for a connection. */
export async function exchangeCode(code: string, verifier: string, redirectUri: string | undefined, fetchFn: FetchFn, now = Date.now()): Promise<DropboxAuth> {
  const data = await tokenCall(
    {
      code: code.trim(),
      grant_type: 'authorization_code',
      client_id: DROPBOX_APP_KEY,
      code_verifier: verifier,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    },
    fetchFn,
  );
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') throw new DropboxError(0, 'no token in the answer');
  return { access: data.access_token, refresh: data.refresh_token, expiresAt: expiry(data, now), accountId: String(data.account_id ?? '') };
}

export async function refreshAccess(auth: DropboxAuth, fetchFn: FetchFn, now = Date.now()): Promise<DropboxAuth> {
  const data = await tokenCall({ grant_type: 'refresh_token', refresh_token: auth.refresh, client_id: DROPBOX_APP_KEY }, fetchFn);
  if (typeof data.access_token !== 'string') throw new DropboxError(0, 'no token in the answer');
  return { ...auth, access: data.access_token, expiresAt: expiry(data, now) };
}

/** Where the reader's connection is kept, and how a refreshed one is saved. */
export interface AuthStore {
  get(): Promise<DropboxAuth | null>;
  /**
   * Save a refreshed connection, only if the stored one has the same refresh token (it was not
   * disconnected or replaced meanwhile). Returns whether it was saved.
   */
  set(auth: DropboxAuth): Promise<boolean>;
}

/** A call to Dropbox with the reader's token, refreshed when it has run out. */
export class DropboxClient {
  constructor(
    private readonly auth: AuthStore,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {}

  private async token(force = false): Promise<string> {
    const auth = await this.auth.get();
    if (!auth) throw new DropboxError(401, 'not connected');
    if (force || auth.expiresAt <= this.now()) {
      const fresh = await refreshAccess(auth, this.fetchFn, this.now());
      // Kept only if it is still the same connection: one disconnected (or replaced) while the
      // refresh was on its way must not come back (AuthStore.set checks the refresh token).
      if (!(await this.auth.set(fresh))) throw new DropboxError(401, 'not connected');
      return fresh.access;
    }
    return auth.access;
  }

  async call(url: string, init: RequestInit): Promise<Response> {
    const send = async (force: boolean) =>
      this.fetchFn(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.token(force)}` },
        signal: timeout(),
      });
    let res = await send(false);
    // Expired early, or revoked: one fresh token, then whatever Dropbox says stands.
    if (res.status === 401) res = await send(true);
    return res;
  }

  /** "Sam Lee (sam@example.org)". */
  async who(): Promise<string> {
    const res = await this.call(`${API}/users/get_current_account`, { method: 'POST' });
    if (!res.ok) throw await failure(res);
    const data = (await res.json()) as { name?: { display_name?: string }; email?: string };
    const name = data.name?.display_name ?? '';
    return data.email ? (name ? `${name} (${data.email})` : data.email) : name;
  }

  /** Take Aloud's access back on Dropbox's side too. */
  async revoke(): Promise<void> {
    await this.call(`${API}/auth/token/revoke`, { method: 'POST' }).catch(() => undefined);
  }
}

async function failure(res: Response): Promise<DropboxError> {
  const text = await res.text().catch(() => '');
  let summary = text.slice(0, 200);
  try {
    const data = JSON.parse(text) as { error_summary?: string };
    if (data.error_summary) summary = data.error_summary;
  } catch {
    /* not JSON: the text itself */
  }
  return new DropboxError(res.status, summary || res.statusText);
}

/** A header value must be ASCII: Dropbox's own advice is to escape the rest in the JSON. */
function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** One file in the app folder, read and written by revision so two devices never overwrite each other. */
export class DropboxFile {
  constructor(
    private readonly client: DropboxClient,
    readonly path: string,
  ) {}

  /** Its current revision, or null when there is no such file. */
  async revision(): Promise<string | null> {
    const res = await this.client.call(`${API}/files/get_metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: this.path }),
    });
    if (res.status === 409) {
      const err = await failure(res);
      if (err.summary.startsWith('path/not_found')) return null;
      throw err;
    }
    if (!res.ok) throw await failure(res);
    const data = (await res.json()) as { rev?: string };
    return data.rev ?? null;
  }

  async download(): Promise<{ text: string; rev: string } | null> {
    const res = await this.client.call(`${CONTENT}/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': apiArg({ path: this.path }) } });
    if (res.status === 409) {
      const err = await failure(res);
      if (err.summary.startsWith('path/not_found')) return null;
      throw err;
    }
    if (!res.ok) throw await failure(res);
    const meta = JSON.parse(res.headers.get('Dropbox-API-Result') ?? '{}') as { rev?: string };
    return { text: await res.text(), rev: meta.rev ?? '' };
  }

  /**
   * Write `text`, over revision `rev` (null: only if there is no file yet). Returns the new
   * revision, or `conflict` when another device wrote in between: read it again and merge.
   */
  async upload(text: string, rev: string | null): Promise<string | 'conflict'> {
    const res = await this.client.call(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg({
          path: this.path,
          mode: rev ? { '.tag': 'update', update: rev } : 'add',
          autorename: false,
          mute: true,
          strict_conflict: true,
        }),
      },
      body: text,
    });
    if (res.status === 409) {
      const err = await failure(res);
      if (err.summary.includes('conflict')) return 'conflict';
      throw err;
    }
    if (!res.ok) throw await failure(res);
    const data = (await res.json()) as { rev?: string };
    return data.rev ?? '';
  }
}
