/**
 * Message protocol between the background event page and the per-tab content script.
 *
 * Transport: `browser.runtime.sendMessage` / `browser.tabs.sendMessage` (request/response),
 * plus a long-lived `browser.runtime.connect` port per active session so the background can
 * observe teardown and keep a single-active-session invariant.
 */

export type PlaybackStatus = 'idle' | 'extracting' | 'loading-model' | 'playing' | 'paused' | 'error';

export interface SessionState {
  status: PlaybackStatus;
  /** 0-based index of the sentence currently playing. */
  currentIndex: number;
  /** Total number of sentences in the document. */
  totalChunks: number;
  /** Human-readable article title. */
  title: string;
  /** Model download progress 0..1 while status === 'loading-model'. */
  modelProgress: number;
  /** Execution provider the engine came up on (`webgpu/fp32`, `wasm`, …). Shown for diagnosis. */
  engineInfo?: string;
  /** True while playback is waiting on a background action (seek, speed change) to catch up. */
  busy?: boolean;
  /** A short call-to-action shown in the bar, e.g. "Press ▶ to start" when autoplay was blocked. */
  hint?: string;
  /** Error text when status === 'error'. */
  error?: string;
  /** Listening left from the current sentence, at the current speed: only what will be read. */
  secondsLeft?: number | null;
}

export type ActivateMode = 'article' | 'selection' | 'from-cursor';

/** Background -> Content */
export type ToContentMessage =
  | { type: 'activate'; mode: ActivateMode; targetElementId?: number }
  | { type: 'toggle' }
  | { type: 'stop'; reason: 'user' | 'superseded' | 'navigation' }
  | { type: 'settings-changed' }
  | { type: 'query-state' }
  /** A short confirmation for the bar, e.g. "Added to your reading queue". */
  | { type: 'flash'; text: string }
  /** The "save to notes" shortcut. */
  | { type: 'save-note' }
  /** The "back a little" shortcut. */
  | { type: 'back-a-little' };

/** Content -> Background */
export type ToBackgroundMessage =
  | { type: 'state'; state: SessionState }
  | { type: 'session-started' }
  | { type: 'session-ended' }
  /** `language`: open the voices for that language (`it`) — a voice the reader is missing. */
  | { type: 'open-options'; language?: string; view?: 'voice' }
  | { type: 'open-walkthrough' }
  | { type: 'open-library'; tab?: LibraryTab };

/** The Library's views on Aloud's page, addressable as `options.html#notes` and so on. */
export type LibraryTab = 'continue' | 'queue' | 'notes' | 'history';

export const PORT_NAME = 'aloud-session';

export function isToContentMessage(m: unknown): m is ToContentMessage {
  return !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string';
}
