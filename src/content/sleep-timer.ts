/**
 * The sleep timer: stop reading at a natural place, or after a while.
 *
 * It never cuts a word in half. Every choice is turned into a *sentence* to stop after — the end
 * of this paragraph, the end of this section, or, when a countdown runs out, the end of whatever
 * sentence is playing at that moment — and the scheduler stops cleanly once that sentence ends
 * (see `stopAfter` in audio/scheduler.ts).
 */
import type { PlaylistItem } from './playlist';

export type SleepChoice = 'off' | 'paragraph' | 'section' | number;

export interface SleepState {
  choice: SleepChoice;
  /** Short text for the bar's badge: "12m", "¶", "§", or '' when off. */
  badge: string;
  /** Sentence to stop after, for a paragraph/section timer that has been armed. */
  stopAfter: number | null;
}

export interface SleepTimerHost {
  currentIndex(): number;
  playlist(): readonly PlaylistItem[];
  isPlaying(): boolean;
  stopAfter(playId: number): void;
  clearStop(): void;
  onChange(state: SleepState): void;
}

/** The last sentence of the paragraph (block) containing `index`. */
export function endOfParagraph(playlist: readonly PlaylistItem[], index: number): number {
  for (let j = index + 1; j < playlist.length; j++) if (playlist[j]!.startsBlock) return j - 1;
  return playlist.length - 1;
}

/** The last sentence before the next heading after `index` — the end of the current section. */
export function endOfSection(playlist: readonly PlaylistItem[], index: number): number {
  for (let j = index + 1; j < playlist.length; j++) if (playlist[j]!.isHeading) return j - 1;
  return playlist.length - 1;
}

const MINUTE = 60_000;

export class SleepTimer {
  private choice: SleepChoice = 'off';
  private stopAt: number | null = null;
  private endsAt = 0;
  private countdown = 0;
  private tick = 0;

  constructor(private readonly host: SleepTimerHost) {}

  get state(): SleepState {
    return { choice: this.choice, badge: this.badge(), stopAfter: this.stopAt };
  }

  /** True while a stop point is set, so pressing play must not clear it. */
  isArmed(): boolean {
    return this.stopAt !== null;
  }

  set(choice: SleepChoice): void {
    this.clear();
    this.choice = choice;
    if (choice === 'paragraph' || choice === 'section') {
      this.arm();
    } else if (typeof choice === 'number') {
      this.endsAt = Date.now() + choice * MINUTE;
      this.countdown = window.setTimeout(() => this.onCountdownEnd(), choice * MINUTE);
      // The badge counts down in whole minutes, so it only needs redrawing a few times a minute.
      this.tick = window.setInterval(() => this.host.onChange(this.state), 15_000);
    }
    this.host.onChange(this.state);
  }

  /** The reader jumped: a paragraph or section timer now means *that* paragraph or section. */
  onSeek(): void {
    if (this.choice === 'paragraph' || this.choice === 'section') this.arm();
  }

  /** Playback stopped at the timer's stop point. */
  onStopReached(): void {
    this.clear();
    this.choice = 'off';
    this.host.onChange(this.state);
  }

  dispose(): void {
    this.clear();
  }

  private arm(): void {
    const list = this.host.playlist();
    if (list.length === 0) return;
    const at = this.host.currentIndex();
    this.stopAt = this.choice === 'section' ? endOfSection(list, at) : endOfParagraph(list, at);
    this.host.stopAfter(this.stopAt);
  }

  private onCountdownEnd(): void {
    window.clearInterval(this.tick);
    this.tick = 0;
    this.countdown = 0;
    if (!this.host.isPlaying()) {
      // Time ran out while paused: there is nothing to stop, so the timer simply ends.
      this.choice = 'off';
      this.host.onChange(this.state);
      return;
    }
    // Finish the sentence being spoken rather than stopping mid-word.
    this.stopAt = this.host.currentIndex();
    this.host.stopAfter(this.stopAt);
    this.host.onChange(this.state);
  }

  private clear(): void {
    window.clearTimeout(this.countdown);
    window.clearInterval(this.tick);
    this.countdown = 0;
    this.tick = 0;
    if (this.stopAt !== null) this.host.clearStop();
    this.stopAt = null;
  }

  private badge(): string {
    if (this.choice === 'paragraph') return '¶';
    if (this.choice === 'section') return '§';
    if (typeof this.choice === 'number') {
      if (this.countdown === 0) return '…';
      return `${Math.max(1, Math.ceil((this.endsAt - Date.now()) / MINUTE))}m`;
    }
    return '';
  }
}
