/**
 * Voice downloads on the settings page: one at a time, the rest waiting their turn — and saying so.
 *
 * Models are tens to hundreds of megabytes over whatever line the reader has, and Kokoro and
 * Supertonic are compiled once downloaded, which is heavy work of its own. Run side by side they
 * only slowed each other down. Before this queue a second Download button pressed during a
 * download did nothing at all, with no word why; and finishing one download redrew the list,
 * which threw away the progress bar of any other still running.
 *
 * So every download goes through here. The first runs; any other waits, and its row says what it
 * is waiting for and where it is in line, with a way to leave the line. Rows read their state from
 * the queue rather than keeping it, so a redrawn list picks up exactly where the old one was.
 */

/** Where a download stands, as a row or the tray shows it. */
export interface JobView {
  key: string;
  label: string;
  phase: 'waiting' | 'downloading' | 'preparing' | 'failed';
  /** 0..1 while downloading. */
  ratio: number;
  /** What the row says. */
  text: string;
  /** 1 for the next to run, 2 for the one after, … (0 for the one running). */
  position: number;
  /** The download running now, for a waiting row to name. */
  ahead: string | null;
}

/** What a download reports as it goes (downloads.ts takes this shape). */
export interface ProgressSink {
  set(ratio: number): void;
  note(text: string): void;
}

/** A waiting download taken out of the line by the reader. */
export class DownloadCancelled extends Error {
  constructor(label: string) {
    super(`${label}: download cancelled`);
    this.name = 'DownloadCancelled';
  }
}

interface Job {
  key: string;
  label: string;
  run: (progress: ProgressSink) => Promise<void>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
  phase: 'waiting' | 'downloading' | 'preparing';
  ratio: number;
  text: string;
}

export class DownloadQueue {
  private readonly jobs: Job[] = [];
  private readonly failures = new Map<string, { label: string; text: string }>();
  private readonly listeners = new Set<() => void>();
  private running = false;

  /** Queue a download (or join it, if this one is already in line); settles when it is done. */
  enqueue(key: string, label: string, run: (progress: ProgressSink) => Promise<void>): Promise<void> {
    const existing = this.jobs.find((j) => j.key === key);
    if (existing) return existing.promise;
    this.failures.delete(key);
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    this.jobs.push({ key, label, run, promise, resolve, reject, phase: 'waiting', ratio: 0, text: '' });
    this.changed();
    void this.pump();
    return promise;
  }

  /** Take a waiting download out of the line. The one running finishes. */
  cancel(key: string): void {
    const i = this.jobs.findIndex((j) => j.key === key && j.phase === 'waiting');
    if (i < 0) return;
    const [job] = this.jobs.splice(i, 1);
    job!.reject(new DownloadCancelled(job!.label));
    this.changed();
  }

  view(key: string): JobView | null {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i < 0) {
      const failed = this.failures.get(key);
      return failed ? { key, label: failed.label, phase: 'failed', ratio: 0, text: failed.text, position: 0, ahead: null } : null;
    }
    const job = this.jobs[i]!;
    const active = this.jobs[0]!;
    return {
      key,
      label: job.label,
      phase: job.phase,
      ratio: job.ratio,
      text: job.phase === 'waiting' ? waitingText(active.label, i) : job.text,
      position: i,
      ahead: i > 0 ? active.label : null,
    };
  }

  /** Every download in line, the running one first. */
  all(): JobView[] {
    return this.jobs.map((j) => this.view(j.key)!);
  }

  get busy(): boolean {
    return this.jobs.length > 0;
  }

  /** Called on every change; returns the way to stop listening. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs[0]!;
        job.phase = 'downloading';
        job.text = `Downloading ${job.label}…`;
        this.changed();
        const sink: ProgressSink = {
          set: (ratio) => {
            job.ratio = Math.max(0, Math.min(1, ratio));
            this.changed();
          },
          note: (text) => {
            // The engines say "preparing" once the bytes are in: still this job's turn.
            if (/prepar/i.test(text)) job.phase = 'preparing';
            job.text = text;
            this.changed();
          },
        };
        try {
          await job.run(sink);
          this.jobs.shift();
          job.resolve();
        } catch (err) {
          this.jobs.shift();
          const message = err instanceof Error ? err.message : String(err);
          this.failures.set(job.key, { label: job.label, text: message });
          job.reject(err instanceof Error ? err : new Error(message));
        }
        this.changed();
      }
    } finally {
      this.running = false;
    }
  }
}

function waitingText(running: string, position: number): string {
  const place = position === 1 ? 'next in line' : `${ordinal(position)} in line`;
  return `Waiting — starts after ${running} finishes (${place})`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** The settings page's one queue: every Download button, and the backup restore, share it. */
export const downloads = new DownloadQueue();
