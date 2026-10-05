/**
 * Keep what is typed into Aloud's own fields away from the page.
 *
 * Aloud's note editor, tags and search live in closed shadow roots, but key events still bubble
 * out of them to the page's listeners: typing "j" into a note moved Gmail down a message, "?"
 * opened a site's shortcut sheet. Stopped at the shadow root, an event from one of Aloud's text
 * fields never reaches the page's bubbling listeners. (Listeners a page registers on the window
 * for the capture phase run before any of this, and cannot be stopped from here.)
 */
const KEY_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(target.type);
  return false;
}

/** Contain typing in `root`'s text fields; returns the unhook. */
export function containTyping(root: ShadowRoot): () => void {
  const stop = (e: Event): void => {
    if (editable(e.composedPath()[0] ?? null)) e.stopPropagation();
  };
  for (const type of KEY_EVENTS) root.addEventListener(type, stop);
  return () => {
    for (const type of KEY_EVENTS) root.removeEventListener(type, stop);
  };
}
