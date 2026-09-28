/**
 * Gapless playback scheduler (content-script main thread).
 *
 * Design: no AudioWorklet (SharedArrayBuffer is unavailable in Firefox extension contexts, so a
 * shared ring buffer is off the table). Instead each sentence's PCM becomes an `AudioBuffer`
 * played by its own `AudioBufferSourceNode`, started at a sample-accurate time computed by
 * accumulating exact buffer durations. A `GainNode` gives click-free pause/resume.
 *
 * The worker synthesises at the target speed, so scheduled sources always play at rate 1.0.
 *
 * Buffering is budgeted in **audio-seconds**, not sentence count: the slower engines
 * (Kokoro / Supertonic) produce ~10 s chunks that each take ~10 s to synthesise on the
 * single-threaded WASM path, so "keep 3 sentences ahead" was not enough headroom and
 * playback underran for ~10 s at a time. We now prime and top up against a seconds target.
 */

export interface SchedulerCallbacks {
  /** Fired (once) when a sentence's audio actually starts, driven by the AudioContext clock. */
  onChunkStart(playId: number): void;
  /** Fired when a sentence's audio ends. */
  onChunkEnd(playId: number): void;
  /** The pipeline should ensure sentences >= fromPlayId are being synthesised. */
  onNeedMore(fromPlayId: number): void;
  /** Ran out of ready audio and had to wait. */
  onUnderrun(playId: number): void;
  /** All sentences have finished playing. */
  onFinished(): void;
  /**
   * Playback reached the sentence set with `stopAfter()` and has stopped there — the sleep timer's
   * "finish this paragraph" moment. Optional: only sessions that set a stop point care.
   */
  onStopReached?(playId: number): void;
}

const PRIME_GAP = 0.12; // seconds of head-room before the first sentence
/** Never let the scheduled audio graph run more than this far ahead of the playhead. */
const MAX_SCHEDULE_AHEAD_SECONDS = 90;

interface PendingChunk {
  pcm: Float32Array;
  sampleRate: number;
  leadSilenceSec: number;
}

export class GaplessScheduler {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly ready = new Map<number, AudioBuffer>();
  /** PCM delivered before `start()` created the AudioContext (pre-buffering). */
  private readonly pendingPcm = new Map<number, PendingChunk>();
  private readonly sources = new Map<number, AudioBufferSourceNode>();
  private readonly timeline: Array<{ playId: number; start: number; end: number; lead: number; announced: boolean }> = [];
  /** Lead silence (seconds) at the front of each ready buffer, so positions can skip it. */
  private readonly leads = new Map<number, number>();

  private count = 0;
  private nextToSchedule = 0;
  private nextStartTime = 0;
  private lastEnded = -1;
  private running = false;
  private disposed = false;
  private ticker = 0;
  /** Seconds of audio to buffer before the first note (blunts an early stutter). */
  private primeSeconds = 2;
  /** Absolute time by which we begin regardless — set once some audio is ready. */
  private primeDeadline = 0;
  private primeTimer = 0;
  /** Last sentence allowed to play before stopping, or null to play on (see `stopAfter`). */
  private stopAfterId: number | null = null;
  /** Set while resuming from a stop point, so the deliberate gap is not reported as an underrun. */
  private resumingFromStop = false;
  /** The `<audio>` element audio is routed through, when that works (see `connectOutput`). */
  private mediaElement: HTMLAudioElement | null = null;

  constructor(private readonly cb: SchedulerCallbacks) {}

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  /**
   * What is being heard right now: the sentence, and how far into its speech (lead silence
   * excluded), allowing for the output device's latency. Null between sentences or when nothing
   * is scheduled. Frozen while paused, since a suspended context's clock stops.
   */
  playbackPosition(): { playId: number; seconds: number } | null {
    if (!this.ctx) return null;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const now = this.ctx.currentTime - latency;
    for (const entry of this.timeline) {
      if (now >= entry.start && now < entry.end) return { playId: entry.playId, seconds: now - entry.start - entry.lead };
    }
    return null;
  }

  /** True when we want to play but the browser is holding the AudioContext for a user gesture. */
  needsGesture(): boolean {
    return this.running && this.ctx != null && this.ctx.state !== 'running';
  }

  /**
   * Must be called from within a user-gesture handler the first time. `startFrom` is where the
   * user currently is (nonzero if they jumped to a section before pressing play).
   */
  async start(totalPlayable: number, startFrom = 0, primeSeconds = 2): Promise<void> {
    this.count = totalPlayable;
    this.primeSeconds = Math.max(0.3, primeSeconds);
    this.primeDeadline = 0;
    const firstTime = !this.ctx;
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.connectOutput(this.ctx, this.gain);
    }
    if (this.ctx.state === 'suspended') {
      // resume() can hang forever when autoplay is blocked (no user gesture yet) — don't await it
      // unbounded, the caller checks `audioContext.state` afterwards.
      await Promise.race([
        this.ctx.resume().catch(() => undefined),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    }
    this.running = true;
    this.playMediaElement();

    // Honour a pre-play seek that happened before there was an AudioContext to aim.
    if (firstTime && startFrom > this.nextToSchedule) {
      this.nextToSchedule = startFrom;
      this.lastEnded = startFrom - 1;
    }
    this.nextStartTime = this.ctx.currentTime + PRIME_GAP;

    // Fold in any PCM that was synthesised while we were still waiting for a user gesture.
    for (const [id, chunk] of this.pendingPcm) {
      if (id >= this.nextToSchedule) this.ingest(id, chunk);
    }
    this.pendingPcm.clear();

    this.startTicker();
    this.cb.onNeedMore(this.nextToSchedule);
    this.pump();
  }

  /**
   * Provide synthesised mono PCM for a sentence.
   * `leadSilenceSec` is deliberate silence prepended to this chunk (section / sentence pause).
   */
  provide(playId: number, pcm: Float32Array, sampleRate: number, leadSilenceSec = 0): void {
    if (this.disposed || playId < this.nextToSchedule) return;
    const chunk: PendingChunk = { pcm, sampleRate, leadSilenceSec: Math.max(0, leadSilenceSec) };
    if (!this.ctx) {
      // Pre-buffering: audio can arrive before playback is started (there is no AudioContext
      // until the user gesture in start()). Hold the raw PCM; start() converts it.
      this.pendingPcm.set(playId, chunk);
      return;
    }
    this.ingest(playId, chunk);
    this.pump();
  }

  private ingest(playId: number, chunk: PendingChunk): void {
    const { pcm, sampleRate, leadSilenceSec } = chunk;
    const lead = Math.round(sampleRate * leadSilenceSec);
    if (pcm.length === 0 && lead === 0) {
      // Nothing to play (e.g. a chunk that normalised to silence) — treat as a 1ms buffer.
      this.ready.set(playId, this.silent(sampleRate));
      return;
    }
    this.leads.set(playId, lead / sampleRate);
    const buf = this.ctx!.createBuffer(1, lead + Math.max(1, pcm.length), sampleRate);
    if (pcm.length > 0) buf.copyToChannel(pcm, 0, lead);
    this.ready.set(playId, buf);
  }

  private silent(sampleRate: number): AudioBuffer {
    return this.ctx!.createBuffer(1, Math.max(1, Math.round(sampleRate * 0.001)), sampleRate);
  }

  /** Seconds of ready-but-not-yet-scheduled audio from `nextToSchedule` forward. */
  private readyAheadSeconds(): number {
    let s = 0;
    for (let i = this.nextToSchedule; this.ready.has(i); i++) s += this.ready.get(i)!.duration;
    return s;
  }

  /** Seconds of audio already on the graph that has not finished playing yet. */
  private scheduledAheadSeconds(): number {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    let s = 0;
    for (const entry of this.timeline) {
      if (entry.end > now) s += entry.end - Math.max(entry.start, now);
    }
    return s;
  }

  /** Have we buffered enough audio (or waited long enough) to begin without an immediate stutter? */
  private primed(): boolean {
    if (this.sources.size > 0) return true;

    const haveAny = this.ready.has(this.nextToSchedule);
    if (!haveAny) return false; // nothing to play yet — not a stutter, just still synthesising

    if (this.readyAheadSeconds() >= this.primeSeconds) return true;
    // Whole remaining article is shorter than the prime target.
    let n = 0;
    for (let i = this.nextToSchedule; this.ready.has(i); i++) n++;
    if (this.nextToSchedule + n >= this.count) return true;

    // We have some audio but not the whole prime buffer. Give synthesis a short grace period,
    // then start anyway rather than sit silent.
    if (!this.primeDeadline) {
      this.primeDeadline = Date.now() + 1800;
      this.primeTimer = self.setTimeout(() => {
        this.primeTimer = 0;
        this.pump();
      }, 1850);
    }
    return Date.now() >= this.primeDeadline;
  }

  private pump(): void {
    if (!this.running || !this.ctx || !this.gain) return;
    if (!this.primed()) return;

    while (
      this.nextToSchedule < this.count &&
      (this.stopAfterId === null || this.nextToSchedule <= this.stopAfterId) &&
      this.ready.has(this.nextToSchedule) &&
      this.scheduledAheadSeconds() < MAX_SCHEDULE_AHEAD_SECONDS
    ) {
      const id = this.nextToSchedule;
      const buf = this.ready.get(id)!;
      this.ready.delete(id);

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);

      const now = this.ctx.currentTime;
      let startAt = this.nextStartTime;
      if (startAt < now + 0.02) {
        startAt = now + 0.02;
        if (id > 0 && !this.resumingFromStop) this.cb.onUnderrun(id);
      }
      this.resumingFromStop = false;
      src.start(startAt);
      const endAt = startAt + buf.duration;

      src.onended = () => this.handleEnded(id);
      this.sources.set(id, src);
      this.timeline.push({ playId: id, start: startAt, end: endAt, lead: this.leads.get(id) ?? 0, announced: false });
      this.leads.delete(id);

      this.nextStartTime = endAt;
      this.nextToSchedule++;
    }

    if (this.nextToSchedule < this.count) {
      this.cb.onNeedMore(Math.min(this.nextToSchedule, this.count - 1));
    }
  }

  private handleEnded(id: number): void {
    const src = this.sources.get(id);
    if (src) {
      try {
        src.disconnect();
      } catch {
        /* noop */
      }
      this.sources.delete(id);
    }
    this.lastEnded = Math.max(this.lastEnded, id);
    this.cb.onChunkEnd(id);
    if (this.stopAfterId !== null && id >= this.stopAfterId && this.sources.size === 0) {
      const stoppedAt = this.stopAfterId;
      this.cb.onStopReached?.(stoppedAt);
      return;
    }
    if (id + 1 >= this.count && this.sources.size === 0) {
      this.running = false;
      this.stopTicker();
      this.cb.onFinished();
      return;
    }
    this.pump();
  }

  private startTicker(): void {
    if (this.ticker) return;
    const tick = () => {
      if (this.disposed) return;
      this.checkTimeline();
      this.ticker = self.setTimeout(tick, 60);
    };
    this.ticker = self.setTimeout(tick, 60);
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearTimeout(this.ticker);
      this.ticker = 0;
    }
  }

  private checkTimeline(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const entry of this.timeline) {
      if (!entry.announced && t >= entry.start - 0.03) {
        entry.announced = true;
        this.cb.onChunkStart(entry.playId);
      }
    }
    // Drop old entries.
    while (this.timeline.length && this.timeline[0]!.end < t - 1) this.timeline.shift();
  }

  isPlaying(): boolean {
    return this.running && this.ctx?.state === 'running';
  }

  async pause(): Promise<void> {
    if (!this.ctx || !this.gain) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0.0001, now + 0.02);
    await new Promise((r) => setTimeout(r, 25));
    await this.ctx.suspend();
    this.mediaElement?.pause();
  }

  async unpause(): Promise<void> {
    if (!this.ctx || !this.gain) return;
    await this.ctx.resume();
    this.playMediaElement();
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(0.0001, now);
    this.gain.gain.linearRampToValueAtTime(1, now + 0.03);
  }

  /**
   * Jump to a sentence: drop everything scheduled/synthesised and re-prime from `playId`.
   * Safe to call before playback has started (no AudioContext yet) — it still records where the
   * scheduler should resume from, which `start()` then honours.
   */
  seek(playId: number): void {
    for (const src of this.sources.values()) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        /* noop */
      }
    }
    this.sources.clear();
    this.ready.clear();
    this.leads.clear();
    this.pendingPcm.clear();
    this.timeline.length = 0;
    this.nextToSchedule = playId;
    this.lastEnded = playId - 1;
    this.primeDeadline = 0;
    this.stopAfterId = null;
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime + PRIME_GAP;
      this.running = true;
      this.startTicker();
    }
    this.cb.onNeedMore(playId);
  }

  /** Speed changed: keep the currently sounding sentence, re-prime the rest. */
  reprimeForSpeed(): void {
    const keep = Math.max(this.lastEnded + 1, 0);
    // The sentence sounding now finishes at the rate it was made at — changing speed should not
    // cut a word in half. `seek()` stopped every source including that one, which is exactly what
    // the reader was told would not happen.
    for (const [id, src] of [...this.sources]) {
      if (id <= keep) continue;
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        /* already finished */
      }
      this.sources.delete(id);
    }
    this.ready.clear();
    this.leads.clear();
    this.pendingPcm.clear();
    // Keep the timeline up to the sentence being kept, and start the next one after it ends.
    const current = this.timeline.find((entry) => entry.playId === keep);
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      if (this.timeline[i]!.playId > keep) this.timeline.splice(i, 1);
    }
    this.nextToSchedule = keep + 1;
    if (this.ctx) {
      this.nextStartTime = Math.max(current?.end ?? 0, this.ctx.currentTime + PRIME_GAP);
      this.running = true;
      this.startTicker();
    }
    this.primeDeadline = 0;
    this.cb.onNeedMore(this.nextToSchedule);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.running = false;
    this.stopTicker();
    if (this.primeTimer) {
      clearTimeout(this.primeTimer);
      this.primeTimer = 0;
    }
    for (const src of this.sources.values()) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        /* noop */
      }
    }
    this.sources.clear();
    this.ready.clear();
    this.leads.clear();
    this.pendingPcm.clear();
    this.timeline.length = 0;
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* noop */
      }
    }
    if (this.mediaElement) {
      this.mediaElement.pause();
      this.mediaElement.srcObject = null;
      this.mediaElement = null;
    }
    this.ctx = null;
    this.gain = null;
  }

  // ---- stop points (sleep timer) -------------------------------------------

  /**
   * Stop cleanly once sentence `playId` has finished, instead of cutting a word in half.
   *
   * Sentences past the stop point may already be on the audio graph — the scheduler runs a long
   * way ahead to stay gapless — so they are taken back off it, with their audio kept so that
   * pressing play again carries straight on. `onStopReached` fires when the last one ends.
   */
  stopAfter(playId: number): void {
    this.stopAfterId = playId;
    let lastKeptEnd: number | null = null;
    for (const [id, src] of [...this.sources]) {
      if (id <= playId) continue;
      src.onended = null;
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* already stopped */
      }
      this.sources.delete(id);
      if (src.buffer) this.ready.set(id, src.buffer);
    }
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const entry = this.timeline[i]!;
      if (entry.playId > playId) {
        this.timeline.splice(i, 1);
        this.leads.set(entry.playId, entry.lead);
      } else if (entry.playId === playId) {
        lastKeptEnd = entry.end;
      }
    }
    if (this.nextToSchedule > playId + 1) {
      this.nextToSchedule = playId + 1;
      this.nextStartTime = lastKeptEnd ?? (this.ctx ? this.ctx.currentTime + PRIME_GAP : 0);
    }
    // Already past it, with nothing left sounding: stop now rather than waiting for an `ended`
    // event that has already happened.
    if (this.lastEnded >= playId && ![...this.sources.keys()].some((id) => id <= playId)) {
      this.cb.onStopReached?.(playId);
    }
  }

  /** Forget the stop point and carry on scheduling from where it left off. */
  clearStopAfter(): void {
    if (this.stopAfterId === null) return;
    this.stopAfterId = null;
    this.resumingFromStop = true;
    if (this.ctx) this.nextStartTime = Math.max(this.nextStartTime, this.ctx.currentTime + PRIME_GAP);
    this.pump();
  }

  // ---- output --------------------------------------------------------------

  /**
   * Route audio through an `<audio>` element rather than straight to the speakers.
   *
   * Browsers hand media keys, headphone buttons, the OS media overlay and the Android lock-screen
   * controls to a page's *media element*. Web Audio on its own does not count as media playback,
   * so without an element those controls never reach Aloud at all. The audio is identical: the
   * graph feeds a MediaStream, and the element plays that stream.
   *
   * If the browser refuses any step, audio goes directly to the destination as before — being
   * heard matters more than being controllable from a keyboard.
   */
  private connectOutput(ctx: AudioContext, gain: GainNode): void {
    try {
      const destination = ctx.createMediaStreamDestination();
      const element = new Audio();
      element.srcObject = destination.stream;
      gain.connect(destination);
      this.mediaElement = element;
    } catch {
      gain.connect(ctx.destination);
    }
  }

  private playMediaElement(): void {
    const element = this.mediaElement;
    if (!element) return;
    void element.play().catch(() => {
      // Refused (an autoplay policy that treats elements more strictly than Web Audio). If the
      // graph itself is running, send it to the speakers directly so nothing goes silent.
      if (this.ctx?.state !== 'running' || !this.gain || this.mediaElement !== element) return;
      try {
        this.gain.disconnect();
      } catch {
        /* not connected */
      }
      this.gain.connect(this.ctx.destination);
      element.srcObject = null;
      this.mediaElement = null;
    });
  }

  /** True when audio is going through a media element, so OS media controls can reach us. */
  get routesThroughMediaElement(): boolean {
    return this.mediaElement !== null;
  }
}
