/** Small shared pieces of the Library page: element lookup and the toast. */

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let toastTimer = 0;

/** A short message at the bottom of the page, optionally with one action ("Undo"). */
export function toast(text: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
  const box = $('toast');
  box.className = kind === 'error' ? 'toast error' : 'toast';
  box.replaceChildren(document.createTextNode(text));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost btn-sm';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      box.hidden = true;
      action.run();
    });
    box.append(button);
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (box.hidden = true), action ? 7000 : 3500);
}

/** "3 days ago", "yesterday", "just now" — for when something was read or noted. */
export function ago(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}
