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

/**
 * Every root whose typing is contained, so its focused field can be asked about (below). Kept on
 * the global object, not in this module: the reader and the note editor are injected as separate
 * scripts, each with its own copy of this module, and only the global is shared between them.
 */
const roots: Set<ShadowRoot> = ((globalThis as { __aloudTypingRoots?: Set<ShadowRoot> }).__aloudTypingRoots ??= new Set());

/** Contain typing in `root`'s text fields; returns the unhook. */
export function containTyping(root: ShadowRoot): () => void {
  const stop = (e: Event): void => {
    if (editable(e.composedPath()[0] ?? null)) e.stopPropagation();
  };
  for (const type of KEY_EVENTS) root.addEventListener(type, stop);
  roots.add(root);
  return () => {
    for (const type of KEY_EVENTS) root.removeEventListener(type, stop);
    roots.delete(root);
  };
}

/**
 * Is one of Aloud's own text fields focused — a note, a tag, a search?
 *
 * Aloud's own key listeners on the window (the reader's one-key controls) hear a key before it
 * reaches the field, and a closed shadow root hides the field from them: the event's target and
 * path stop at the root's host. Typing "banana" into a note saved "aa"; the other letters were
 * reader keys. The roots themselves can say what has focus inside them.
 */
export function typingInOwnField(): boolean {
  for (const root of roots) if (root.host.isConnected && editable(root.activeElement)) return true;
  return false;
}
