/**
 * The reader's own speech server: its addresses, its voices, and what they speak.
 *
 * The server is whatever OpenAI-style speech API the reader runs (Kokoro-FastAPI, openedai-speech
 * and others): `POST {base}/audio/speech` speaks, and most list their voices at
 * `{base}/audio/voices`. The reader enters the base (`http://localhost:8880/v1`); a trailing slash
 * or a pasted `/audio/speech` is tidied away.
 */

/** `http://pc:8880/v1/` or `http://pc:8880/v1/audio/speech` → `http://pc:8880/v1`. Empty if not a web address. */
export function serverBase(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '').replace(/\/audio\/(speech|voices)$/, '');
}

/**
 * Is `hostname` on this machine or the reader's own network? Plain http is fine there. Anything
 * else is the internet, where the text read and the key must not cross in the clear.
 * Tailscale counts as one's own network: its 100.64/10 addresses and *.ts.net names travel
 * encrypted inside it.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h.includes('.') && !h.includes(':')) return true; // a single-label name: `pc`, `localhost`
  if (/(^|\.)(localhost|local|lan|internal|home\.arpa|ts\.net)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  // IPv6: loopback, unique local (fc00::/7), link-local (fe80::/10).
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** Why `base` may not be used, or null: a server on the internet must be reached over https. */
export function serverAddressProblem(base: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return 'That is not a web address.';
  }
  if (url.protocol === 'https:' || isLocalHost(url.hostname)) return null;
  return `${url.hostname} is on the internet, so Aloud only talks to it over https:// (the text you read, and any key, would otherwise travel unencrypted). Put the server behind https, or use its address on your own network.`;
}

/** The request headers that carry the server's key, if it has one. */
export function serverHeaders(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function speechUrl(base: string): string {
  return `${base}/audio/speech`;
}

export function voicesUrl(base: string): string {
  return `${base}/audio/voices`;
}

/** The permission to ask for: this host on any port (both browsers match ports that way). */
export function serverOrigin(base: string): string {
  const url = new URL(base);
  return `${url.protocol}//${url.hostname}/*`;
}

/** The voice names in a voice-list answer: `{voices: [...]}` (Kokoro-FastAPI), or a bare list. */
export function voicesFrom(answer: unknown): string[] {
  const list = Array.isArray(answer) ? answer : (answer as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(list)) return [];
  const names = list.map((v) => (typeof v === 'string' ? v : (v as { id?: unknown; name?: unknown })?.id ?? (v as { name?: unknown })?.name));
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length < 100))];
}

/**
 * Kokoro's voice names start with their language: `af_heart` is American English, `ff_siwis`
 * French. Servers running Kokoro keep those names, so the voice board can put each on its
 * language. Anything else (`alloy`, a cloned voice) is taken to be English.
 */
const KOKORO_PREFIX: Record<string, string> = { a: 'en-US', b: 'en-GB', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-BR', z: 'zh' };

export function serverVoiceLanguage(voice: string): string {
  const m = /^([abefhijpz])[fm]_/.exec(voice);
  return m ? KOKORO_PREFIX[m[1]!]! : 'en';
}
