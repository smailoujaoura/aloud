import { CONTROL_HOST_ID } from '@/ui/control-bar';

/**
 * Click (or tap) a sentence in the page to jump playback there.
 *
 * Deliberately non-invasive: it listens in the capture phase but never calls `preventDefault`,
 * so the page keeps behaving normally. Anything that looks like the user meant something else —
 * a link, a form control, a text selection, a double-click, our own control bar — is left alone.
 */

/** Elements whose clicks belong to the page, never to us. */
const INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'audio',
  'video',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ');

export interface TapToSeekOptions {
  /** Playlist index at a viewport point, or null when the point is not on readable text. */
  hitTest(x: number, y: number): number | null;
  /** The user picked a sentence. The originating click is a real user gesture. */
  onSeek(playId: number): void;
  /** False while the session cannot act on a jump — still extracting, or failed. */
  canSeek(): boolean;
}

export class TapToSeek {
  private handler: ((e: MouseEvent) => void) | null = null;
  private onDown: ((e: PointerEvent) => void) | null = null;
  /** Where the press started, and whether text was selected then (see `onClick`). */
  private press: { x: number; y: number; hadSelection: boolean } | null = null;

  constructor(
    private readonly doc: Document,
    private readonly opts: TapToSeekOptions,
  ) {}

  /** Attach or detach the page listener. Idempotent, so it is safe to call on every settings change. */
  setEnabled(enabled: boolean): void {
    if (enabled === (this.handler !== null)) return;
    if (enabled) this.attach();
    else this.detach();
  }

  dispose(): void {
    this.detach();
  }

  private attach(): void {
    const handler = (e: MouseEvent): void => this.onClick(e);
    const onDown = (e: PointerEvent): void => {
      const selection = this.doc.defaultView?.getSelection();
      this.press = { x: e.clientX, y: e.clientY, hadSelection: !!selection && !selection.isCollapsed };
    };
    this.handler = handler;
    this.onDown = onDown;
    this.doc.addEventListener('pointerdown', onDown, true);
    this.doc.addEventListener('click', handler, true);
  }

  private detach(): void {
    if (!this.handler) return;
    this.doc.removeEventListener('click', this.handler, true);
    if (this.onDown) this.doc.removeEventListener('pointerdown', this.onDown, true);
    this.handler = null;
    this.onDown = null;
  }

  private onClick(e: MouseEvent): void {
    if (e.button !== 0 || e.detail > 1 || e.defaultPrevented) return;
    if (!this.opts.canSeek()) return;

    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    if (e.composedPath().some((n) => n instanceof HTMLElement && n.id === CONTROL_HOST_ID)) return;

    // The user is selecting text, not asking to jump: a selection now, a press that dragged, or a
    // click (a tap) that only cleared the selection there was — that last one used to jump.
    const selection = this.doc.defaultView?.getSelection();
    if (selection && !selection.isCollapsed) return;
    const press = this.press;
    this.press = null;
    if (press && (press.hadSelection || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6)) return;

    const playId = this.opts.hitTest(e.clientX, e.clientY);
    if (playId != null) this.opts.onSeek(playId);
  }
}
