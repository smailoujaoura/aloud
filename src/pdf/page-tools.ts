/**
 * Where you are in a PDF, and how big it is drawn: "Page 3 / 12", and − 100% +.
 *
 * Many PDFs print no page numbers, and a long one gave no sense of how far there was to go. The
 * page shown is the one under the upper part of the window, the part being read; typing a number
 * goes there.
 */

export interface PageTools {
  setPage(page: number): void;
  setZoom(zoom: number): void;
  dispose(): void;
}

export interface PageToolsOptions {
  total: number;
  /** Page images that can be drawn again at another size (the page view, not the text view). */
  zoomable: boolean;
  onPage(page: number): void;
  onZoom(how: 'in' | 'out' | 'fit'): void;
}

function button(text: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

export function pageTools(opts: PageToolsOptions): PageTools {
  const bar = document.createElement('div');
  bar.className = 'page-tools';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Pages');

  const at = document.createElement('input');
  at.type = 'text';
  at.inputMode = 'numeric';
  at.className = 'page-at';
  at.value = '1';
  at.setAttribute('aria-label', `Page, of ${opts.total}`);
  at.size = Math.max(2, String(opts.total).length);
  const of = document.createElement('span');
  of.className = 'page-of';
  of.textContent = `/ ${opts.total}`;

  let shown = 1;
  const go = (): void => {
    const n = Number.parseInt(at.value, 10);
    if (Number.isFinite(n)) opts.onPage(Math.min(opts.total, Math.max(1, n)));
    at.value = String(shown);
  };
  at.addEventListener('focus', () => at.select());
  at.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
      at.blur();
    } else if (e.key === 'Escape') {
      at.value = String(shown);
      at.blur();
    }
  });
  at.addEventListener('blur', () => (at.value = String(shown)));
  bar.append(at, of);

  let level: HTMLButtonElement | null = null;
  if (opts.zoomable) {
    const group = document.createElement('span');
    group.className = 'zoom-group';
    level = button('100%', 'Fit the width (Ctrl+0)', () => opts.onZoom('fit'), 'zoom-level');
    group.append(
      document.createElement('span'),
      button('−', 'Smaller (Ctrl+−)', () => opts.onZoom('out'), 'icon-btn'),
      level,
      button('+', 'Larger (Ctrl++)', () => opts.onZoom('in'), 'icon-btn'),
    );
    group.firstElementChild!.className = 'tools-sep';
    bar.append(group);
  }
  document.body.append(bar);

  return {
    setPage(page) {
      shown = page;
      if (document.activeElement !== at) at.value = String(page);
    },
    setZoom(zoom) {
      if (level) level.textContent = `${Math.round(zoom * 100)}%`;
    },
    dispose() {
      bar.remove();
    },
  };
}

/**
 * The page at the reading line (a third of the way down the window), from elements that each
 * start a page, in document order. Binary search: a book has hundreds.
 */
export function pageAtReadingLine(starts: ReadonlyArray<{ el: Element; page: number }>): number {
  const line = window.innerHeight / 3;
  let lo = 0;
  let hi = starts.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]!.el.getBoundingClientRect().top <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return starts[found]?.page ?? 1;
}
