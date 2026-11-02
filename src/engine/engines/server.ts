/**
 * The reader's own speech server (issue #9): no model runs in the browser. Each sentence's text is
 * sent to the OpenAI-style API the reader set up (Kokoro-FastAPI on a PC at home, say, or across a
 * Tailscale network), and its audio comes back to be played and highlighted as usual.
 *
 * Only the address the reader entered and granted is contacted; nothing else leaves the browser.
 * Asked for WAV, which carries its own sample rate. Such servers send no word timings, so the
 * session estimates them from the audio, as it does for Supertonic.
 */
import { decodeWav } from '@/audio/wav-decode';
import { serverAddressProblem, serverHeaders, speechUrl, voicesUrl } from '@/shared/server-voices';
import type { InitContext, SynthEngine, SynthResult } from './types';

/** What OpenAI's API calls its speech model; Kokoro-FastAPI and most others accept it too. */
const DEFAULT_MODEL = 'tts-1';
/** Long enough for a slow server's first sentence, while it loads its model. */
const TIMEOUT_MS = 120_000;

export class ServerEngine implements SynthEngine {
  readonly id = 'server' as const;
  readonly executionProvider = 'server';
  sampleRate = 24000;
  private voice = '';

  constructor(
    private readonly base: string,
    private readonly model: string,
    private readonly key = '',
  ) {}

  async init(ctx: InitContext): Promise<void> {
    if (!this.base) throw new Error('No server address is set. Add one in Settings → Voice → Your own server.');
    const problem = serverAddressProblem(this.base);
    if (problem) throw new Error(problem);
    this.voice = ctx.voice;
    // Reachable at all, and does it take the key? A clear message now beats a failed first sentence.
    let res: Response;
    try {
      res = await fetch(voicesUrl(this.base), { headers: serverHeaders(this.key), signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new Error(`Can't reach the speech server at ${this.base} (${err instanceof Error ? err.message : String(err)}). Is it running, and is this the right address?`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(refused(this.base, this.key));
  }

  async synthesize(text: string, speed: number, voice?: string): Promise<SynthResult> {
    let res: Response;
    try {
      res = await fetch(speechUrl(this.base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serverHeaders(this.key) },
        body: JSON.stringify({ model: this.model || DEFAULT_MODEL, input: text, voice: voice || this.voice, speed, response_format: 'wav' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`The speech server at ${this.base} didn't answer (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error(refused(this.base, this.key));
    if (!res.ok) throw new Error(`The speech server said ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const { pcm, sampleRate } = decodeWav(await res.arrayBuffer());
    this.sampleRate = sampleRate;
    return { pcm, sampleRate };
  }

  dispose(): void {}
}

function refused(base: string, key: string): string {
  return key
    ? `The speech server at ${base} refused the key. Check it in Settings → Voice → Your own server.`
    : `The speech server at ${base} asks for a key. Add it in Settings → Voice → Your own server.`;
}
