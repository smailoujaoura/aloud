/**
 * Which worker gets the next sentence.
 *
 * The pool only pays for itself if the sentences are spread across it, and the naive way to do
 * that — round-robin each request to the workers that exist when it arrives — quietly fails in
 * the one case that matters. The reader asks for its whole lookahead (24 sentences for Kokoro on
 * the CPU) the instant worker 0 says `ready`, which is *seconds* before workers 1..N finish
 * compiling their own copy of the model. Round-robin therefore posts all 24 to worker 0, they sit
 * in that worker's private queue, and the rest of the pool comes up to find nothing to do. That
 * is a pool that costs four models' worth of memory and synthesises at exactly one worker's speed
 * — measured: 4 sentences in ~50 s, each one starting only after the previous finished.
 *
 * So jobs are held *here* instead, and handed out one at a time to a worker that is idle. A
 * worker holds exactly the sentence it is working on, and every worker that comes up later
 * immediately pulls the next job from the queue. It also makes a seek cheap: the sentences the
 * user just skipped past are still in this queue and are dropped by `clear()`, rather than being
 * buried in four workers' internal queues.
 *
 * Generic over the worker and job types, and free of globals, so the policy can be tested without
 * a DOM or a real Worker.
 */

export class JobQueue<W, J> {
  private readonly pending: J[] = [];
  /** Which job each working worker is on — the queue is also the record of what is in flight. */
  private readonly busy = new Map<W, J>();

  constructor(
    private readonly send: (worker: W, job: J) => void,
    /** Identifies a job, so the same sentence is never handed out twice at once. */
    private readonly keyOf: (job: J) => number,
  ) {}

  /** Jobs waiting for a free worker. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Workers currently synthesising. */
  get busyCount(): number {
    return this.busy.size;
  }

  /** What each busy worker is working on. */
  busyJobs(): Array<[W, J]> {
    return [...this.busy];
  }

  /**
   * Queue a job, then hand out as much work as the pool can take right now.
   *
   * A job already queued or already running is dropped. That is what makes it safe for a seek to
   * leave in-flight work alone: the reader re-requests the sentences around the new position, and
   * the one a worker is already halfway through is recognised rather than started a second time.
   */
  submit(job: J, ready: readonly W[]): void {
    const key = this.keyOf(job);
    if (this.pending.some((queued) => this.keyOf(queued) === key)) return;
    for (const running of this.busy.values()) if (this.keyOf(running) === key) return;

    this.pending.push(job);
    this.pump(ready);
  }

  /** A worker finished, failed, or was cancelled — it can take the next job. */
  release(worker: W, ready: readonly W[]): void {
    this.busy.delete(worker);
    this.pump(ready);
  }

  /** A worker is gone for good (terminated). Whatever it held is gone with it. */
  forget(worker: W): void {
    this.busy.delete(worker);
  }

  /** Give queued jobs to idle workers, in arrival order. Also how a new worker gets its first. */
  pump(ready: readonly W[]): void {
    for (const worker of ready) {
      if (this.pending.length === 0) return;
      if (this.busy.has(worker)) continue;
      const job = this.pending.shift()!;
      this.busy.set(worker, job);
      this.send(worker, job);
    }
  }

  /**
   * Drop everything not yet started.
   *
   * A seek or speed change invalidates the queue: the reader re-requests exactly what it still
   * wants. What to do about work already *running* is a separate decision — see the synth-host,
   * which cannot interrupt a worker and terminates the ones whose sentence is no longer wanted.
   */
  clear(): void {
    this.pending.length = 0;
  }

  /** Forget the pool entirely (teardown, or a new `init`). */
  reset(): void {
    this.pending.length = 0;
    this.busy.clear();
  }
}
