// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { ControlBar, speedChoices, type ControlBarCallbacks } from '@/ui/control-bar';

function bar(speed: number) {
  const noop = () => undefined;
  const onSpeed = vi.fn();
  const cb = {
    onPlay: noop, onPause: noop, onPrev: noop, onNext: noop, onSeekFraction: noop, onSpeed, onVoice: noop,
    onToggleTapToSeek: noop, onSnapToCurrent: noop, onSaveNote: noop, onBackALittle: noop, onSleep: noop,
    onExportStart: noop, onExportCancel: noop, onExportSave: noop, onOpenSettings: noop, onOpenWalkthrough: noop,
    onTipsDismissed: noop, onClose: noop, onVoiceLock: noop, onMissingVoice: noop, onManageVoices: noop, onFollow: noop,
  } as unknown as ControlBarCallbacks;
  const b = new ControlBar(document, cb, { speed, tapToSeek: false, theme: 'light' });
  const list = (b as unknown as { root: ShadowRoot }).root.querySelector<HTMLSelectElement>('select.speed')!;
  const shown = () => list.selectedOptions[0]?.textContent ?? '';
  return { b, list, shown, onSpeed };
}

/**
 * #12: the reading speed is set on the bar, from its list of usual speeds, or in Settings, Voice,
 * in steps of 0.05. The bar's list had no line for a speed that is none of the usual ones, so it
 * showed nothing, and 0.5× (its first line) once the page was opened again.
 */
describe('the bar shows the speed it reads at, whatever that is (#12)', () => {
  it('a usual speed is offered as before, with no line added', () => {
    const { list, shown } = bar(1.5);
    expect(shown()).toBe('1.5×');
    expect([...list.options].map((o) => o.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '1.75×', '2×', '2.5×', '3×', '3.5×', '4×']);
  });

  it('a speed set in Settings that is none of them opens on its own line, not on 0.5×', () => {
    const { list, shown } = bar(2.75);
    expect(shown()).toBe('2.75×');
    expect(list.value).toBe('2.75');
    expect([...list.options].map((o) => o.textContent)).toContain('2.75×');
    // In its place among the others.
    expect([...list.options].map((o) => Number(o.value))).toEqual([...speedChoices(2.75)]);
    expect(speedChoices(2.75).indexOf(2.75)).toBe(8);
  });

  it('follows a speed changed in Settings while the bar is open, and drops the line when it is left', () => {
    const { b, list, shown } = bar(1);
    b.setSpeed(1.3);
    expect(shown()).toBe('1.3×');
    b.setSpeed(2);
    expect(shown()).toBe('2×');
    expect([...list.options].map((o) => o.textContent)).not.toContain('1.3×');
  });

  it('faster and slower step to the usual speed beside it', () => {
    const up = bar(1.3);
    up.b.press('faster');
    expect(up.onSpeed).toHaveBeenLastCalledWith(1.5); // it went to 1.25×: down
    expect(up.shown()).toBe('1.5×');

    const down = bar(1.3);
    down.b.press('slower');
    expect(down.onSpeed).toHaveBeenLastCalledWith(1.25);

    const top = bar(4);
    top.b.press('faster');
    expect(top.onSpeed).not.toHaveBeenCalled();

    const usual = bar(1);
    usual.b.press('faster');
    expect(usual.onSpeed).toHaveBeenLastCalledWith(1.25);
    usual.b.press('slower');
    usual.b.press('slower');
    expect(usual.onSpeed).toHaveBeenLastCalledWith(0.75);
  });

  it('normal speed goes back to 1× from any speed', () => {
    const { b, shown, onSpeed } = bar(2.75);
    b.press('normal');
    expect(onSpeed).toHaveBeenLastCalledWith(1);
    expect(shown()).toBe('1×');
  });
});
