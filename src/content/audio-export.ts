/**
 * "Save as MP3": turn the whole planned document into one audio file.
 *
 * It borrows the reader's own synthesis workers — the voice is already loaded, so there is nothing
 * to download or compile — and asks for sentences a window at a time, the same way playback does,
 * so a pool of workers stays busy. Audio can arrive out of order; it is held until the sentences
 * before it are in, then encoded straight away, in order, with the same pauses reading would use.
 */
import { Mp3Writer } from '@/audio/mp3-encoder';
import { log } from '@/shared/log';

export interface ExportHost {
  /** Sentences in the document. */
  count: number;
  /** How many sentences to keep requested ahead of the one being encoded. */
  lookahead: number;
  /** Ask for sentence `id`; its audio comes back through `accept`. */
  request(id: number): void;
  /** Silence to put before sentence `id` (section and sentence pauses). */
  leadSilenceSec(id: number): number;
  onProgress(done: number, total: number): void;
  onDone(file: Blob, seconds: number): void;
  onError(message: string): void;
}

export class Mp3Export {
  private next = 0;
  private requestedUpTo = -1;
  private readonly waiting = new Map<number, { pcm: Float32Array; sampleRate: number }>();
  private writer: Mp3Writer | null = null;
  private stopped = false;

  constructor(private readonly host: ExportHost) {}

  start(): void {
    if (this.host.count === 0) {
      this.fail('There is nothing on this page to save');
      return;
    }
    this.host.onProgress(0, this.host.count);
    this.topUp();
  }

  /**
   * Audio for sentence `id`. An empty `pcm` means the sentence could not be synthesised; it
   * becomes silence in the file rather than stopping the export.
   */
  accept(id: number, pcm: Float32Array, sampleRate: number): void {
    if (this.stopped || id < this.next || this.waiting.has(id)) return;
    this.waiting.set(id, { pcm, sampleRate });
    try {
      this.drain();
    } catch (err) {
      log.error('mp3 encoding failed:', err instanceof Error && err.stack ? err.stack : err);
      this.fail(`Could not encode the audio: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.topUp();
  }

  cancel(): void {
    this.stopped = true;
    this.waiting.clear();
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  private drain(): void {
    while (!this.stopped && this.waiting.has(this.next)) {
      const { pcm, sampleRate } = this.waiting.get(this.next)!;
      this.waiting.delete(this.next);
      // The first sentence with real audio fixes the file's sample rate; every engine produces
      // one rate throughout, so later sentences always match it.
      this.writer ??= pcm.length > 0 ? new Mp3Writer(sampleRate) : null;
      if (this.writer) {
        this.writer.silence(this.host.leadSilenceSec(this.next));
        this.writer.write(pcm);
      }
      this.next++;
      this.host.onProgress(this.next, this.host.count);
    }
    if (!this.stopped && this.next >= this.host.count) this.finish();
  }

  private topUp(): void {
    const limit = Math.min(this.host.count - 1, this.next + this.host.lookahead);
    while (!this.stopped && this.requestedUpTo < limit) {
      this.requestedUpTo++;
      this.host.request(this.requestedUpTo);
    }
  }

  private finish(): void {
    this.stopped = true;
    if (!this.writer) {
      this.host.onError('None of the sentences on this page could be turned into audio');
      return;
    }
    this.host.onDone(this.writer.finish(), this.writer.durationSeconds);
  }

  private fail(message: string): void {
    this.stopped = true;
    this.waiting.clear();
    this.host.onError(message);
  }
}

const MAX_NAME = 80;

/** A file name from a page title: no path separators, reserved or control characters, not too long. */
export function audioFileName(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let base = clean.slice(0, MAX_NAME);
  // Cut at a word boundary rather than mid-word, unless that would leave almost nothing.
  if (clean.length > MAX_NAME) {
    const space = base.lastIndexOf(' ');
    if (space > MAX_NAME / 2) base = base.slice(0, space);
  }
  base = base.replace(/[\s.]+$/, '');
  return `${base || 'Aloud'}.mp3`;
}
