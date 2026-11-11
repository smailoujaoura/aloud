import { describe, expect, it } from 'vitest';
import { DROPBOX_APP_KEY, DropboxClient, DropboxError, DropboxFile, authorizeUrl, exchangeCode, pkcePair, type DropboxAuth } from '@/sync/dropbox';

interface Call {
  url: string;
  init: RequestInit;
}

/** Dropbox, as far as Aloud talks to it: answers queued per call. */
function fakeDropbox(answers: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected call to ${url}`);
    return answer(call);
  };
  return { calls, fetchFn };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function memoryAuth(auth: DropboxAuth) {
  let current = auth;
  return { get: async () => current, set: async (next: DropboxAuth) => void (current = next), now: () => current };
}

const AUTH: DropboxAuth = { access: 'old', refresh: 'refresh-1', expiresAt: 10_000, accountId: 'dbid:1' };
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

describe('signing in', () => {
  it('asks for a refresh token with PKCE, and the redirect only when there is one to catch', async () => {
    const { challenge } = await pkcePair();
    const url = new URL(authorizeUrl(challenge, 'https://abc.chromiumapp.org/', 'state-1'));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: DROPBOX_APP_KEY,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      redirect_uri: 'https://abc.chromiumapp.org/',
      state: 'state-1',
    });
    // A phone: Dropbox shows the code instead.
    expect(new URL(authorizeUrl(challenge)).searchParams.has('redirect_uri')).toBe(false);
  });

  it('the challenge is the SHA-256 of the verifier, in base64url', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(challenge).toBe(Buffer.from(digest).toString('base64url'));
  });

  it('trades the code for tokens, without a secret', async () => {
    const { calls, fetchFn } = fakeDropbox([() => json(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 14400, account_id: 'dbid:9' })]);
    const auth = await exchangeCode(' code-1 ', 'verifier-1', undefined, fetchFn, 0);
    expect(auth).toEqual({ access: 'a1', refresh: 'r1', expiresAt: 14340 * 1000, accountId: 'dbid:9' });
    const body = Object.fromEntries(new URLSearchParams(String(calls[0]?.init.body)));
    expect(body).toEqual({ code: 'code-1', grant_type: 'authorization_code', client_id: DROPBOX_APP_KEY, code_verifier: 'verifier-1' });
  });

  it('a refused code says why', async () => {
    const { fetchFn } = fakeDropbox([() => json(400, { error: 'invalid_grant', error_description: 'code doesn\'t exist or has expired' })]);
    await expect(exchangeCode('x', 'v', undefined, fetchFn)).rejects.toThrow(/has expired/);
  });
});

describe('the file', () => {
  it('an access token that ran out is refreshed first, and the fresh one kept', async () => {
    const auth = memoryAuth(AUTH);
    const { calls, fetchFn } = fakeDropbox([
      () => json(200, { access_token: 'new', expires_in: 14400 }),
      (call) => (header(call, 'Authorization') === 'Bearer new' ? json(200, { rev: '015a' }) : json(401, {})),
    ]);
    const file = new DropboxFile(new DropboxClient(auth, fetchFn, () => 20_000), '/aloud.json');
    expect(await file.revision()).toBe('015a');
    expect(calls[0]?.url).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(auth.now().access).toBe('new');
  });

  it('a token refused before its time is refreshed once, and the call made again', async () => {
    const auth = memoryAuth({ ...AUTH, expiresAt: 99_999 });
    const { calls, fetchFn } = fakeDropbox([
      () => json(401, { error_summary: 'expired_access_token/' }),
      () => json(200, { access_token: 'new', expires_in: 14400 }),
      () => json(200, { rev: '016b' }),
    ]);
    const file = new DropboxFile(new DropboxClient(auth, fetchFn, () => 0), '/aloud.json');
    expect(await file.revision()).toBe('016b');
    expect(header(calls[2]!, 'Authorization')).toBe('Bearer new');
  });

  it('no file yet is null, not an error', async () => {
    const { fetchFn } = fakeDropbox([() => json(409, { error_summary: 'path/not_found/..' }), () => json(409, { error_summary: 'path/not_found/...' })]);
    const file = new DropboxFile(new DropboxClient(memoryAuth({ ...AUTH, expiresAt: 1e15 }), fetchFn), '/aloud.json');
    expect(await file.revision()).toBeNull();
    expect(await file.download()).toBeNull();
  });

  it('reads the text with its revision', async () => {
    const { calls, fetchFn } = fakeDropbox([
      () => new Response('{"format":"aloud-sync"}', { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: '0170' }) } }),
    ]);
    const file = new DropboxFile(new DropboxClient(memoryAuth({ ...AUTH, expiresAt: 1e15 }), fetchFn), '/aloud.json');
    expect(await file.download()).toEqual({ text: '{"format":"aloud-sync"}', rev: '0170' });
    expect(JSON.parse(header(calls[0]!, 'Dropbox-API-Arg')!)).toEqual({ path: '/aloud.json' });
  });

  it('writes only over the revision it read, and says when another device wrote first', async () => {
    const { calls, fetchFn } = fakeDropbox([() => json(200, { rev: '0181' }), () => json(409, { error_summary: 'path/conflict/file/..' })]);
    const file = new DropboxFile(new DropboxClient(memoryAuth({ ...AUTH, expiresAt: 1e15 }), fetchFn), '/aloud.json');
    expect(await file.upload('{}', '0180')).toBe('0181');
    expect(JSON.parse(header(calls[0]!, 'Dropbox-API-Arg')!)).toMatchObject({ mode: { '.tag': 'update', update: '0180' }, autorename: false, strict_conflict: true });
    expect(await file.upload('{}', null)).toBe('conflict');
    expect(JSON.parse(header(calls[1]!, 'Dropbox-API-Arg')!).mode).toBe('add');
  });

  it('a header carries only ASCII: anything else is escaped in its JSON', async () => {
    const { calls, fetchFn } = fakeDropbox([() => json(409, { error_summary: 'path/not_found/' })]);
    await new DropboxFile(new DropboxClient(memoryAuth({ ...AUTH, expiresAt: 1e15 }), fetchFn), '/notes – é 🙂.json').download();
    const arg = header(calls[0]!, 'Dropbox-API-Arg')!;
    expect(/^[\x20-\x7e]*$/.test(arg)).toBe(true);
    expect(JSON.parse(arg)).toEqual({ path: '/notes – é 🙂.json' });
  });

  it('other answers are errors with Dropbox’s own summary', async () => {
    const { fetchFn } = fakeDropbox([() => json(409, { error_summary: 'path/insufficient_space/..' })]);
    const file = new DropboxFile(new DropboxClient(memoryAuth({ ...AUTH, expiresAt: 1e15 }), fetchFn), '/aloud.json');
    const err = await file.upload('{}', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DropboxError);
    expect((err as DropboxError).summary).toBe('path/insufficient_space/..');
  });
});
