/**
 * More than one voice on a page, with a bounded number of models loaded.
 *
 * A lane is one synthesis host (`WorkerClient`) with one model. The *primary* lane carries the
 * voice most of the page is read with: it is loaded before reading starts, and its readiness,
 * progress and execution provider are the reader's. A passage in another language goes to a
 * secondary lane, started the first time one of its sentences is asked for (a few sentences
 * ahead of playback), and kept while it is useful.
 *
 * Bounded: at most `MAX_LANES` models are loaded, and a secondary lane runs few workers. The
 * least recently used secondary lane is closed to make room; what it still owed is reported, so
 * the reader can ask again. Kokoro's voices share one model, so every Kokoro voice is one lane.
 *
 * Every sentence asked for is owned by the lane it was asked of. Audio from any other lane —
 * asked before a correction moved the passage to another voice — is dropped, never played as the
 * new voice's.
 */
import { WorkerClient, type WorkerClientCallbacks } from '@/engine/worker-client';
import type { EngineConfig, WordTiming } from '@/engine/protocol';
import type { VoiceRef } from '@/shared/settings';
import { log } from '@/shared/log';

/** The primary lane and up to two others. */
export const MAX_LANES = 3;
/** Workers per secondary lane: enough to keep ahead of reading, without a second full pool. */
const SECONDARY_WORKERS = 2;

export interface LaneCallbacks extends WorkerClientCallbacks {
  /** A secondary voice started loading (`ready: false`) or finished (`ready: true`). */
  onLaneState?(voice: VoiceRef, ready: boolean): void;
  /** A secondary voice could not be loaded; `playIds` were asked of it and will not come. */
  onLaneFailed?(voice: VoiceRef, message: string, playIds: number[]): void;
  /** A secondary lane was closed to make room; `playIds` were asked of it and will not come. */
  onLaneClosed?(playIds: number[]): void;
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

/** Kokoro's voices share one model; every other voice is a model of its own. */
export function laneKey(v: VoiceRef): string {
  return v.engine === 'kokoro' ? 'kokoro' : `${v.engine}:${v.voice}`;
}

export class VoiceLanes {
  private primary: Lane | null = null;
  private readonly others = new Map<string, Lane>();
  /** Voices that failed to load: not tried again on this page. */
  private readonly failed = new Set<string>();
  /** playId → the key of the lane it was asked of. */
  private readonly owner = new Map<number, string>();
  private clock = 0;

  constructor(private readonly cb: LaneCallbacks) {}

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
    if (!lane) return;
    lane.lastUsed = ++this.clock;
    this.owner.set(playId, key);
    // Kokoro remembers the last voice it was given, so every Kokoro request names its own.
    const perJob = ref.engine === 'kokoro' ? ref.voice : '';
    if (!lane.ready) {
      lane.queued.push({ playId, text, speed, voice: perJob });
      return;
    }
    lane.client.request(playId, text, speed, perJob || undefined);
  }

  /** Drop queued work everywhere, keeping in-flight work for `keepAhead` items from `playId`. */
  cancelFrom(playId: number, keepAhead: number): void {
    this.owner.clear();
    this.primary?.client.cancelFrom(playId, keepAhead);
    for (const lane of this.others.values()) {
      lane.queued = [];
      if (lane.ready) lane.client.cancelFrom(playId, keepAhead);
    }
  }

  isPending(playId: number): boolean {
    return this.owner.has(playId);
  }

  /** How many models are loaded or loading — for the residency test. */
  get laneCount(): number {
    return (this.primary ? 1 : 0) + this.others.size;
  }

  dispose(): void {
    this.closeOthers();
    this.primary?.client.dispose();
    this.primary = null;
    this.owner.clear();
  }

  private dropOwner(playId: number): void {
    const was = this.owner.get(playId);
    if (was === undefined) return;
    this.owner.delete(playId);
    const lane = was === this.primary?.key ? this.primary : this.others.get(was);
    if (!lane) return;
    lane.queued = lane.queued.filter((q) => q.playId !== playId);
    lane.client.forget(playId);
  }

  private deliver(key: string, playId: number, pcm: Float32Array, sr: number, words?: WordTiming[]): void {
    if (this.owner.get(playId) !== key) return; // asked again of another voice since
    this.owner.delete(playId);
    this.cb.onAudio(playId, pcm, sr, words);
  }

  private laneFor(ref: VoiceRef, key: string): Lane | null {
    if (this.failed.has(`${ref.engine}:${ref.voice}`)) return null;
    const open = this.others.get(key);
    if (open) return open;
    if (this.laneCount >= MAX_LANES) this.closeLeastRecent();
    const primary = this.primary!;
    const config: EngineConfig = {
      ...primary.config,
      engine: ref.engine,
      voice: ref.voice,
      workers: Math.min(SECONDARY_WORKERS, primary.config.workers || SECONDARY_WORKERS),
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
          if (info.fatal) return; // reported by the failed init below
          if (info.playId != null && this.owner.get(info.playId) === key) {
            this.owner.delete(info.playId);
            this.cb.onError(info);
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
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[voices] ${ref.engine}/${ref.voice} could not load:`, message);
        this.others.delete(key);
        lane.client.dispose();
        this.failed.add(`${ref.engine}:${ref.voice}`);
        this.cb.onLaneFailed?.(ref, message, this.release(key));
      },
    );
    return lane;
  }

  /** Every playId owned by lane `key`, no longer owned by anything. */
  private release(key: string): number[] {
    const ids: number[] = [];
    for (const [playId, k] of this.owner) if (k === key) ids.push(playId);
    for (const id of ids) this.owner.delete(id);
    return ids;
  }

  private closeLeastRecent(): void {
    let oldest: Lane | null = null;
    for (const lane of this.others.values()) if (!oldest || lane.lastUsed < oldest.lastUsed) oldest = lane;
    if (!oldest) return;
    log.info(`[voices] closing ${oldest.key} to make room`);
    this.others.delete(oldest.key);
    oldest.client.dispose();
    const ids = this.release(oldest.key);
    if (ids.length) this.cb.onLaneClosed?.(ids);
  }

  private closeOthers(): void {
    for (const lane of this.others.values()) lane.client.dispose();
    this.others.clear();
  }
}
