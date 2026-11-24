// @vitest-environment happy-dom
/**
 * The reading bar dragged between the bottom and the top of the window. happy-dom lays nothing
 * out, so the bar's box is given here: where the dock's class and the drag's transform put it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlBar, type ControlBarCallbacks, type ControlBarOptions } from '@/ui/control-bar';
import { PageNotesPanel } from '@/annotate/notes-panel';
import { READING_ATTR } from '@/annotate/palette';

const BAR_HEIGHT = 52;

function makeBar(opts: Partial<ControlBarOptions> = {}) {
  const noop = () => undefined;
  const onDock = vi.fn();
  const onPlay = vi.fn();
  const cb = {
    onPlay, onPause: noop, onPrev: noop, onNext: noop, onSeekFraction: noop, onSpeed: noop, onVoice: noop,
    onToggleTapToSeek: noop, onSnapToCurrent: noop, onSaveNote: noop, onBackALittle: noop, onSleep: noop,
    onExportStart: noop, onExportCancel: noop, onExportSave: noop, onOpenSettings: noop, onOpenWalkthrough: noop,
    onTipsDismissed: noop, onClose: noop, onDock,
  } as unknown as ControlBarCallbacks;
  const b = new ControlBar(document, cb, { speed: 1, tapToSeek: false, theme: 'light', ...opts });
  const root = (b as unknown as { root: ShadowRoot }).root;
  const dock = root.querySelector<HTMLElement>('.dock')!;
  const bar = root.querySelector<HTMLElement>('.bar')!;
  const peek = root.querySelector<HTMLElement>('.peek')!;
  // Resting at its edge, moved by whatever the drag's transform says.
  bar.getBoundingClientRect = () => {
    const shift = Number(/translate\(-50%, (-?\d+)px\)/.exec(dock.style.transform)?.[1] ?? 0);
    const top = (dock.classList.contains('at-top') ? 0 : window.innerHeight - BAR_HEIGHT) + shift;
    return new DOMRect(100, top, 600, BAR_HEIGHT);
  };
  return { b, root, dock, bar, peek, onDock, onPlay };
}

const pointer = (type: string, target: EventTarget, x: number, y: number, pointerType = 'mouse') =>
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, pointerType, clientX: x, clientY: y }),
  );

/** A press at `y` on `target`, moved to `to`, and let go. */
function drag(target: Element, y: number, to: number, pointerType = 'mouse'): void {
  pointer('pointerdown', target, 300, y, pointerType);
  pointer('pointermove', window, 300, y + (to - y) / 2, pointerType);
  pointer('pointermove', window, 300, to, pointerType);
  pointer('pointerup', window, 300, to, pointerType);
}

const room = () => document.querySelector('[data-aloud-room]');
let open: ControlBar | null = null;
afterEach(() => {
  open?.dispose();
  open = null;
});

describe('the bar sits at the edge it was put at', () => {
  it('the bottom unless said otherwise, with room at the end of the page', () => {
    const t = makeBar();
    open = t.b;
    expect(t.dock.classList.contains('at-top')).toBe(false);
    expect(t.b.dockedAt).toBe('bottom');
    expect(room()).not.toBeNull();
  });

  it('the top when the setting says so: the handle left when hidden too, and no room at the end', () => {
    const t = makeBar({ dock: 'top' });
    open = t.b;
    expect(t.dock.classList.contains('at-top')).toBe(true);
    expect(t.peek.classList.contains('at-top')).toBe(true);
    expect(room()).toBeNull();
  });

  it('keeps the sentence clear of it at its own edge', () => {
    const t = makeBar({ dock: 'top' });
    open = t.b;
    // Its foot (52, right at the edge) and a little air.
    expect(t.b.insets()).toEqual({ top: 64, bottom: 0 });
    t.b.setDock('bottom');
    expect(t.b.insets().top).toBe(0);
    expect(t.b.insets().bottom).toBeGreaterThan(0);
  });

  it('moves when Settings changes it, and says where in the Hide button', () => {
    const t = makeBar();
    open = t.b;
    const hide = t.root.querySelector<HTMLButtonElement>('button.hide')!;
    expect(hide.title).toContain('near the bottom');
    t.b.setDock('top');
    expect(t.dock.classList.contains('at-top')).toBe(true);
    expect(hide.title).toContain('near the top');
    expect(room()).toBeNull();
  });
});

describe('dragging the bar to the other edge', () => {
  it('picked up by its surface and let go near the top: it goes there and says so', async () => {
    const t = makeBar();
    open = t.b;
    const sep = t.root.querySelector('.sep')!;
    drag(sep, window.innerHeight - 40, 60);
    expect(t.dock.classList.contains('at-top')).toBe(true);
    expect(t.onDock).toHaveBeenCalledWith('top');
    expect(room()).toBeNull();
    // It slides the rest of the way, then nothing of the drag is left on it.
    await new Promise((r) => setTimeout(r, 400));
    expect(t.dock.style.transform).toBe('');
    expect(t.dock.style.transition).toBe('');
  });

  it('follows the pointer up and down while held, and stays in the window', () => {
    const t = makeBar();
    open = t.b;
    const sep = t.root.querySelector('.sep')!;
    const from = window.innerHeight - 40;
    pointer('pointerdown', sep, 300, from);
    pointer('pointermove', window, 300, from - 200);
    expect(t.dock.style.transform).toBe('translate(-50%, -200px)');
    expect(t.bar.classList.contains('dragging')).toBe(true);
    pointer('pointermove', window, 300, -5000);
    expect(t.bar.getBoundingClientRect().top).toBe(4);
    pointer('pointerup', window, 300, -5000);
    expect(t.bar.classList.contains('dragging')).toBe(false);
  });

  it('let go short of the middle, it goes back, and nothing is saved', () => {
    const t = makeBar();
    open = t.b;
    drag(t.root.querySelector('.sep')!, window.innerHeight - 40, window.innerHeight - 200);
    expect(t.dock.classList.contains('at-top')).toBe(false);
    expect(t.onDock).not.toHaveBeenCalled();
  });

  it('back down from the top, with a finger', () => {
    const t = makeBar({ dock: 'top' });
    open = t.b;
    drag(t.root.querySelector('.sep')!, 40, window.innerHeight - 30, 'touch');
    expect(t.dock.classList.contains('at-top')).toBe(false);
    expect(t.onDock).toHaveBeenCalledWith('bottom');
    expect(room()).not.toBeNull();
  });

  it('a press on a button, the progress bar or the speed list is theirs, not a drag', () => {
    const t = makeBar();
    open = t.b;
    for (const sel of ['button.play', '.progress', 'select.speed']) {
      drag(t.root.querySelector(sel)!, window.innerHeight - 40, 40);
      expect(t.dock.classList.contains('at-top'), sel).toBe(false);
    }
    expect(t.onDock).not.toHaveBeenCalled();
  });

  it('a press that hardly moves is not a drag, and a button still clicks', () => {
    const t = makeBar();
    open = t.b;
    drag(t.root.querySelector('.sep')!, 700, 705);
    expect(t.dock.style.transform).toBe('');
    t.root.querySelector<HTMLButtonElement>('button.play')!.click();
    expect(t.onPlay).toHaveBeenCalledTimes(1);
  });

  it('the click a drag ends in is not taken for a press of what it ended over', () => {
    const t = makeBar();
    open = t.b;
    drag(t.root.querySelector('.sep')!, window.innerHeight - 40, 60);
    t.root.querySelector<HTMLButtonElement>('button.play')!.click();
    expect(t.onPlay).not.toHaveBeenCalled();
  });

  it('a drag the browser takes over (pointercancel) leaves it where it was', () => {
    const t = makeBar();
    open = t.b;
    const sep = t.root.querySelector('.sep')!;
    pointer('pointerdown', sep, 300, 700, 'touch');
    pointer('pointermove', window, 300, 100, 'touch');
    pointer('pointercancel', window, 300, 100, 'touch');
    expect(t.dock.classList.contains('at-top')).toBe(false);
    expect(t.onDock).not.toHaveBeenCalled();
  });

  it('lets go of the window when the bar is closed mid-drag', () => {
    const t = makeBar();
    const sep = t.root.querySelector('.sep')!;
    pointer('pointerdown', sep, 300, 700);
    pointer('pointermove', window, 300, 500);
    t.b.dispose();
    pointer('pointermove', window, 300, 100);
    pointer('pointerup', window, 300, 100);
    expect(t.onDock).not.toHaveBeenCalled();
  });
});

describe('the notes panel keeps clear of the bar at either edge', () => {
  const panel = () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const p = new PageNotesPanel(root, { pageKey: 'k', reveal: () => true, remove: async () => undefined });
    p.open([], []);
    return { p, sheet: () => root.querySelector('.notes-sheet')! };
  };

  it('stops above a bar at the bottom, below one at the top, and neither once reading stops', async () => {
    document.documentElement.setAttribute(READING_ATTR, 'bottom');
    const { p, sheet } = panel();
    expect(sheet().classList.contains('above-bar')).toBe(true);
    expect(sheet().classList.contains('below-bar')).toBe(false);
    document.documentElement.setAttribute(READING_ATTR, 'top');
    await Promise.resolve();
    expect(sheet().classList.contains('above-bar')).toBe(false);
    expect(sheet().classList.contains('below-bar')).toBe(true);
    document.documentElement.removeAttribute(READING_ATTR);
    await Promise.resolve();
    expect(sheet().classList.contains('above-bar')).toBe(false);
    expect(sheet().classList.contains('below-bar')).toBe(false);
    p.close();
  });

  it('an older reader that set the mark with no edge is taken as the bottom', () => {
    document.documentElement.setAttribute(READING_ATTR, '');
    const { p, sheet } = panel();
    expect(sheet().classList.contains('above-bar')).toBe(true);
    p.close();
    document.documentElement.removeAttribute(READING_ATTR);
  });
});
