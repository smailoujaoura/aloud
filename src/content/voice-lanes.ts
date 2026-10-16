/**
 * More than one voice on a page, with a bounded number of models loaded.
 *
 * A lane is one synthesis host (`WorkerClient`) with one model. The *primary* lane carries the
 * voice most of the page is read with: it is loaded before reading starts, and its readiness,
 * progress and execution provider are the reader's. A passage in another language goes to a
 * secondary lane, started the first time one of its sentences is asked for (a few sentences
 * ahead of playback), and kept while it is useful.
 *
 * Bounded: at most `MAX_LANES` models are loaded, and a secondary lane runs few workers. Only a
 * lane that owes nothing is closed to make room — the least recently used of them. A voice that
 * finds every lane still busy waits its turn and is let in the moment one has delivered all it
 * owed: nothing asked for is ever dropped, nothing is asked for twice, and an export waiting on
 * that voice simply waits (closing a busy lane lost its sentences, and a re-request from inside
 * the eviction opened a fourth model). Kokoro's voices share one model, so they are one lane.
 *
 * Every sentence asked for is owned by the lane it was asked of. Audio from any other lane —
 * asked before a correction moved the passage to another voice — is dropped, never played as the
 * new voice's.
 */
import { sharesModel } from '@/shared/engine-catalog';
import { WorkerClient, type WorkerClientCallbacks } from '@/engine/worker-client';
import type { EngineConfig, WordTiming } from '@/engine/protocol';
import type { VoiceRef } from '@/shared/settings';
import { log } from '@/shared/log';

/** The primary lane and up to two others (on a phone, one other: see `VoiceLanes`). */
export const MAX_LANES = 3;
/**
 * Workers per secondary lane: one. A fixed count overrides the synthesis host's own rules — one
 * worker for Piper, one on a GPU, one on a phone — and two copies of a second model (Supertonic is
 * ~260 MB each) beside the main voice's pool was memory a phone does not have. A passage in another
 * language is a small share of the page; one worker reads it.
 */
const SECONDARY_WORKERS = 1;

export interface LaneCallbacks extends WorkerClientCallbacks {
  /** A secondary voice started loading (`ready: false`) or finished (`ready: true`). */
  onLaneState?(voice: VoiceRef, ready: boolean): void;
  /** A secondary voice could not be loaded; `playIds` were asked of it and will not come. */
  onLaneFailed?(voice: VoiceRef, message: string, playIds: number[]): void;
}

interface Lane {
  key: string;
  client: WorkerClient;
  config: EngineConfig;
  ready: boolean;
  /** Asked for before the lane was ready. */
  queued: Array<{ playId: number; text: string; speed: number; voice: string }>;
  lastUsed: number;
}

/** Kokoro's voices share one model, and Supertonic's; each Piper voice is a model of its own. */
export function laneKey(v: VoiceRef): string {
  return sharesModel(v.engine) ? v.engine : `${v.engine}:${v.voice}`;
}

export class VoiceLanes {
  private primary: Lane | null = null;
  private readonly others = new Map<string, Lane>();
  /** Voices that failed to load: not tried again on this page. */
  private readonly failed = new Set<string>();
  /** playId → the key of the lane it was asked of (or is waiting for). */
  private readonly owner = new Map<number, string>();
  /** Asked of a voice with no room for its model yet, in order; let in as lanes go idle. */
  private waiting: Array<{ playId: number; text: string; speed: number; ref: VoiceRef; key: string }> = [];
  private clock = 0;

  /** How many models may be loaded at once: MAX_LANES, or fewer (a phone passes 2). */
  private readonly maxLanes: number;

  constructor(
    private readonly cb: LaneCallbacks,
    opts: { maxLanes?: number } = {},
  ) {
    this.maxLanes = Math.max(1, Math.min(MAX_LANES, opts.maxLanes ?? MAX_LANES));
  }

  /** Load the primary voice; every other lane is closed. Resolves when it is ready. */
  async init(config: EngineConfig): Promise<void> {
    this.closeOthers();
    this.owner.clear();
    this.failed.clear();
    const key = laneKey({ engine: config.engine, voice: config.voice });
    const lane: Lane = {
      key,
      config,
      ready: false,
      queued: [],
      lastUsed: ++this.clock,
      client: new WorkerClient({
        ...this.cb,
        // Ready here, not when `init` resumes: the reader starts asking for sentences inside its
        // own `onReady`, which runs first — those requests were held for a lane not yet marked
        // ready, and never sent.
        onReady: (info) => {
          this.markReady(lane);
          this.cb.onReady(info);
        },
        onAudio: (playId, pcm, sr, words) => this.deliver(key, playId, pcm, sr, words),
        onError: (info) => {
          if (info.playId != null && this.owner.get(info.playId) === key) this.owner.delete(info.playId);
          this.cb.onError(info);
        },
      }),
    };
    this.primary?.client.dispose();
    this.primary = lane;
    await lane.client.init(config);
    this.markReady(lane);
  }

  /** The lane can take work: send what was asked of it while it loaded. */
  private markReady(lane: Lane): void {
    if (lane.ready) return;
    lane.ready = true;
    const queued = lane.queued;
    lane.queued = [];
    for (const q of queued) {
      if (this.owner.get(q.playId) === lane.key) lane.client.request(q.playId, q.text, q.speed, q.voice || undefined);
    }
  }

  /** Can `voice` be read at all — not a voice that failed to load on this page? */
  usable(voice: VoiceRef): boolean {
    return !this.failed.has(`${voice.engine}:${voice.voice}`);
  }

  /** Synthesise `playId` with `voice` (the primary voice when omitted). */
  request(playId: number, text: string, speed: number, voice?: VoiceRef): void {
    const primary = this.primary;
    if (!primary) return;
    const ref = voice ?? { engine: primary.config.engine, voice: primary.config.voice };
    const key = laneKey(ref);
    if (this.owner.get(playId) === key) return;
    // Asked of another lane before: that answer is no longer wanted.
    this.dropOwner(playId);

    const lane = key === primary.key ? primary : this.laneFor(ref, key);
    if (lane === 'wait') {
      this.owner.set(playId, key);
      this.waiting.push({ playId, text, speed, ref, key });
      return;
    }
    if (!lane) return;
    this.send(lane, ref, playId, text, speed);
  }

  private send(lane: Lane, ref: VoiceRef, playId: number, text: string, speed: number): void {
    const key = lane.key;
    lane.lastUsed = ++this.clock;
    this.owner.set(playId, key);
    // Kokoro and Supertonic remember the last voice they were given, so each request names its own.
    const perJob = sharesModel(ref.engine) ? ref.voice : '';
    if (!lane.ready) {
      lane.queued.push({ playId, text, speed, voice: perJob });
      return;
    }
    lane.client.request(playId, text, speed, perJob || undefined);
  }

  /** Drop queued work everywhere, keeping in-flight work for `keepAhead` items from `playId`. */
  cancelFrom(playId: number, keepAhead: number): void {
    this.owner.clear();
    this.waiting = [];
    this.primary?.client.cancelFrom(playId, keepAhead);
    for (const lane of this.others.values()) {
      lane.queued = [];
      if (lane.ready) lane.client.cancelFrom(playId, keepAhead);
    }
  }

  /** Stop waiting for `playId`: whatever is coming for it is dropped (a sentence that changed). */
  drop(playId: number): void {
    this.dropOwner(playId);
  }

  isPending(playId: number): boolean {
    return this.owner.has(playId);
  }

  /** How many models are loaded or loading — for the residency test. */
  get laneCount(): number {
    return (this.primary ? 1 : 0) + this.others.size;
  }

  dispose(): void {
    this.waiting = [];
    this.closeOthers();
    this.primary?.client.dispose();
    this.primary = null;
    this.owner.clear();
  }

  private dropOwner(playId: number): void {
    const was = this.owner.get(playId);
    if (was === undefined) return;
    this.owner.delete(playId);
    this.waiting = this.waiting.filter((w) => w.playId !== playId);
    const lane = was === this.primary?.key ? this.primary : this.others.get(was);
    if (!lane) return;
    lane.queued = lane.queued.filter((q) => q.playId !== playId);
    lane.client.forget(playId);
    this.admitWaiting();
  }

  private deliver(key: string, playId: number, pcm: Float32Array, sr: number, words?: WordTiming[]): void {
    if (this.owner.get(playId) !== key) return; // asked again of another voice since
    this.owner.delete(playId);
    this.cb.onAudio(playId, pcm, sr, words);
    this.admitWaiting();
  }

  /** Does lane `key` still owe audio? */
  private owes(key: string): boolean {
    for (const k of this.owner.values()) if (k === key) return true;
    return false;
  }

  /** Let in waiting voices, oldest first, as far as there is room. Never closes a busy lane. */
  private admitWaiting(): void {
    while (this.waiting.length) {
      const first = this.waiting[0]!;
      const lane = this.laneFor(first.ref, first.key);
      if (lane === 'wait') return;
      const mine = this.waiting.filter((w) => w.key === first.key);
      this.waiting = this.waiting.filter((w) => w.key !== first.key);
      for (const w of mine) {
        if (this.owner.get(w.playId) !== w.key) continue;
        if (!lane) {
          // Its voice failed meanwhile: these will not come from it.
          this.owner.delete(w.playId);
          continue;
        }
        this.send(lane, w.ref, w.playId, w.text, w.speed);
      }
    }
  }

  private laneFor(ref: VoiceRef, key: string): Lane | null | 'wait' {
    if (this.failed.has(`${ref.engine}:${ref.voice}`)) return null;
    const open = this.others.get(key);
    if (open) return open;
    if (this.laneCount >= this.maxLanes && !this.closeLeastRecentIdle()) return 'wait';
    const primary = this.primary!;
    const config: EngineConfig = {
      ...primary.config,
      engine: ref.engine,
      voice: ref.voice,
      workers: SECONDARY_WORKERS,
    };
    const lane: Lane = {
      key,
      config,
      ready: false,
      queued: [],
      lastUsed: ++this.clock,
      client: new WorkerClient({
        onReady: () => undefined,
        onProgress: () => undefined,
        onAudio: (playId, pcm, sr, words) => this.deliver(key, playId, pcm, sr, words),
        onError: (info) => {
          if (info.fatal) {
            // Before ready, the failed init below reports it. After — a host whose workers could not
            // be restarted — nothing else would: the lane is gone, and what it owed goes back.
            if (lane.ready) this.failLane(lane, ref, info.message);
            return;
          }
          if (info.playId != null && this.owner.get(info.playId) === key) {
            this.owner.delete(info.playId);
            this.cb.onError(info);
            this.admitWaiting();
          }
        },
        onNotice: (message) => this.cb.onNotice?.(message),
      }),
    };
    this.others.set(key, lane);
    log.info(`[voices] loading ${ref.engine}/${ref.voice} beside ${primary.config.engine}/${primary.config.voice}`);
    this.cb.onLaneState?.(ref, false);
    lane.client.init(config).then(
      () => {
        if (this.others.get(key) !== lane) return;
        log.info(`[voices] ${ref.engine}/${ref.voice} ready`);
        this.markReady(lane);
        this.cb.onLaneState?.(ref, true);
      },
      (err: unknown) => {
        if (this.others.get(key) !== lane) return; // closed on purpose
        this.failLane(lane, ref, err instanceof Error ? err.message : String(err));
      },
    );
    return lane;
  }

  /** A voice that cannot be used on this page: closed, not tried again, its sentences handed back. */
  private failLane(lane: Lane, ref: VoiceRef, message: string): void {
    if (this.others.get(lane.key) !== lane) return;
    log.warn(`[voices] ${ref.engine}/${ref.voice} failed:`, message);
    this.others.delete(lane.key);
    lane.client.dispose();
    this.failed.add(`${ref.engine}:${ref.voice}`);
    const owed = this.release(lane.key);
    this.cb.onLaneFailed?.(ref, message, owed);
    this.admitWaiting();
  }

  /** Every playId owned by lane `key`, no longer owned by anything. */
  private release(key: string): number[] {
    const ids: number[] = [];
    for (const [playId, k] of this.owner) if (k === key) ids.push(playId);
    for (const id of ids) this.owner.delete(id);
    return ids;
  }

  /** Close the least recently used secondary lane that owes nothing; false when every one is busy. */
  private closeLeastRecentIdle(): boolean {
    let oldest: Lane | null = null;
    for (const lane of this.others.values()) {
      if (this.owes(lane.key)) continue;
      if (!oldest || lane.lastUsed < oldest.lastUsed) oldest = lane;
    }
    if (!oldest) return false;
    log.info(`[voices] closing ${oldest.key} to make room`);
    this.others.delete(oldest.key);
    oldest.client.dispose();
    return true;
  }

  private closeOthers(): void {
    for (const lane of this.others.values()) lane.client.dispose();
    this.others.clear();
  }
}
