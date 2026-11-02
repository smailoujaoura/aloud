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
