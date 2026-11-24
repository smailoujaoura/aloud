// @vitest-environment happy-dom
/** The notes panel on a web page can be dragged by its header, and opens where it was put. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: vi.fn(async () => undefined) } } }));

import { PageNotesPanel } from '@/annotate/notes-panel';
import { READING_ATTR } from '@/annotate/palette';
import { storage } from 'wxt/utils/storage';
import { resetStorage } from '../stubs/wxt-storage';

const SPOT_KEY = 'local:notesPanelSpot';
const WIDTH = 360;

function setWindow(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

/** happy-dom lays nothing out: the sheet is as wide as its stylesheet says, and where its style puts it. */
function measure(sheet: HTMLElement): void {
  sheet.getBoundingClientRect = () => {
    const left = sheet.style.left ? parseFloat(sheet.style.left) : window.innerWidth - 12 - WIDTH;
    const top = sheet.style.top ? parseFloat(sheet.style.top) : 12;
    const height = sheet.style.height ? parseFloat(sheet.style.height) : window.innerHeight - 24;
    return { left, top, width: WIDTH, height, right: left + WIDTH, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
  };
}

async function openPanel() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const panel = new PageNotesPanel(root, { pageKey: 'k', reveal: () => true, remove: async () => {} });
  const origAppend = root.append.bind(root);
  root.append = (...nodes: Array<Node | string>) => {
    for (const n of nodes) if (n instanceof HTMLElement && n.classList.contains('notes-sheet')) measure(n);
    origAppend(...nodes);
  };
  panel.open([], []);
  const sheet = root.querySelector<HTMLElement>('.notes-sheet')!;
  // The stored spot is read before it is shown.
  await vi.waitFor(() => expect(sheet.classList.contains('placing')).toBe(false));
  const head = root.querySelector<HTMLElement>('.sheet-head')!;
  return { panel, root, sheet, head };
}

const pointer = (type: string, x: number, y: number, extra: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, composed: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: x, clientY: y, ...extra });

function drag(head: HTMLElement, from: [number, number], to: [number, number]): void {
  head.dispatchEvent(pointer('pointerdown', ...from));
  window.dispatchEvent(pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  window.dispatchEvent(pointer('pointermove', ...to));
  window.dispatchEvent(pointer('pointerup', ...to));
}

beforeEach(() => {
  resetStorage();
  setWindow(1280, 800);
  document.body.replaceChildren();
  document.documentElement.removeAttribute(READING_ATTR);
});
afterEach(() => vi.restoreAllMocks());

describe('dragging the notes panel', () => {
  it('opens at the side until it is moved', async () => {
    const { sheet, head } = await openPanel();
    expect(sheet.classList.contains('moved')).toBe(false);
    expect(sheet.style.left).toBe('');
    expect(head.title).toContain('Double-click to put it back');
  });

  it('follows the pointer by its header, stays in the window, and is remembered', async () => {
    const { sheet, head, panel } = await openPanel();
    // From the side sheet's corner (908, 12), 400 to the left and 100 down.
    drag(head, [950, 30], [550, 130]);
    expect(sheet.classList.contains('moved')).toBe(true);
    expect(sheet.style.left).toBe('508px');
    expect(sheet.style.top).toBe('112px');
    expect(sheet.style.height).toBe('560px');
    await vi.waitFor(async () => expect(await storage.getItem(SPOT_KEY)).toMatchObject({ x: expect.any(Number), y: expect.any(Number) }));

    // Far past the bottom-left corner: kept just inside it.
    drag(head, [550, 130], [-900, 2000]);
    expect(sheet.style.left).toBe('12px');
    expect(sheet.style.top).toBe(`${800 - 12 - 560}px`);

    // Closed and opened again: where it was put.
    panel.close();
    const again = await openPanel();
    await vi.waitFor(() => expect(again.sheet.style.left).toBe('12px'));
    expect(again.sheet.style.top).toBe(`${800 - 12 - 560}px`);
  });

  it('a click on a header button still works; the click a drag ends in does not', async () => {
    const { root, head } = await openPanel();
    const all = [...root.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.startsWith('All'))!;
    const page = [...root.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.startsWith('This page'))!;
    // Less than 8 px: a click.
    all.dispatchEvent(pointer('pointerdown', 900, 30));
    window.dispatchEvent(pointer('pointermove', 904, 33));
    window.dispatchEvent(pointer('pointerup', 904, 33));
    all.click();
    expect(all.getAttribute('aria-pressed')).toBe('true');
    // A drag from "This page": its click is swallowed.
    drag(page, [850, 30], [600, 200]);
    page.click();
    expect(page.getAttribute('aria-pressed')).toBe('false');
    expect(head.isConnected).toBe(true);
  });

  it('a double-click on the header puts it back at the side, and forgets the spot', async () => {
    const { sheet, head } = await openPanel();
    drag(head, [950, 30], [550, 130]);
    await vi.waitFor(async () => expect(await storage.getItem(SPOT_KEY)).not.toBeNull());
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    expect(sheet.classList.contains('moved')).toBe(false);
    expect(sheet.style.left).toBe('');
    await vi.waitFor(async () => expect(await storage.getItem(SPOT_KEY)).toBeNull());
  });

  it('a drag on the header does not reach the page', async () => {
    const { head } = await openPanel();
    const seen: string[] = [];
    for (const type of ['pointerdown', 'pointerup', 'mouseup']) document.addEventListener(type, () => seen.push(type));
    head.dispatchEvent(pointer('pointerdown', 950, 30));
    head.dispatchEvent(pointer('pointerup', 950, 30));
    head.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    expect(seen).toEqual([]);
  });

  it('on a phone-width window it stays the sheet it opens as, and cannot be dragged', async () => {
    await storage.setItem(SPOT_KEY, { x: 0.5, y: 0.5 });
    setWindow(400, 800);
    const { sheet, head } = await openPanel();
    expect(sheet.classList.contains('movable')).toBe(false);
    expect(sheet.classList.contains('moved')).toBe(false);
    expect(head.title).toBe('');
    drag(head, [100, 30], [100, 300]);
    expect(sheet.style.top).toBe('');
    // Made wide again: back where it was put.
    setWindow(1280, 800);
    window.dispatchEvent(new Event('resize'));
    expect(sheet.classList.contains('moved')).toBe(true);
    expect(sheet.style.left).toBe(`${Math.round(12 + 0.5 * (1280 - 360 - 24))}px`);
  });

  it('is kept clear of the reading bar while Aloud reads, and goes back when it stops', async () => {
    await storage.setItem(SPOT_KEY, { x: 0.5, y: 1 });
    const { sheet } = await openPanel();
    expect(sheet.style.top).toBe(`${800 - 12 - 560}px`);
    // A bar along the bottom, found where it is drawn.
    const bar = document.createElement('div');
    bar.id = 'aloud-control-host';
    document.documentElement.append(bar);
    const covers = (x: number, y: number) => x >= 180 && x < 1100 && y >= 716 && y < 780;
    vi.spyOn(document, 'elementFromPoint').mockImplementation((x, y) => (covers(x, y) ? bar : document.body));
    document.documentElement.setAttribute(READING_ATTR, '');
    await vi.waitFor(() => expect(parseFloat(sheet.style.top) + 560).toBeLessThanOrEqual(716 - 8));
    // Reading stops: back to where it was put.
    bar.remove();
    document.documentElement.removeAttribute(READING_ATTR);
    await vi.waitFor(() => expect(sheet.style.top).toBe(`${800 - 12 - 560}px`));
  });
});
