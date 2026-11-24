/**
 * One key recorder at a time, on the whole settings page.
 *
 * A key is set by clicking its button and pressing the new key. Two buttons clicked one after the
 * other both waited for the next key, and whichever listened first took it. Starting one now stops
 * the one before, as Esc would; so does a press anywhere else on the page. While one waits, its
 * button carries `data-recording`, which also holds the page's redraws (main.ts: busyHere).
 */
let active: { button: HTMLElement; stop: () => void } | null = null;

/**
 * `button` starts waiting for a key; `stop` ends that wait unchanged (the recorder's own "Esc").
 * Returns what the recorder calls when it is done, however it ends.
 */
export function beginRecording(button: HTMLElement, stop: () => void): () => void {
  active?.stop();
  const away = (e: Event): void => {
    if (!(e.target instanceof Node) || !button.contains(e.target)) stop();
  };
  window.addEventListener('pointerdown', away, true);
  button.dataset.recording = '';
  const me = { button, stop };
  active = me;
  return () => {
    window.removeEventListener('pointerdown', away, true);
    delete button.dataset.recording;
    if (active === me) active = null;
  };
}

/** A second click on the button that is waiting: it stops, rather than starting again. */
export function stopIfRecording(button: HTMLElement): boolean {
  if (active?.button !== button) return false;
  active.stop();
  return true;
}
