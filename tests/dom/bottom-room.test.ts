// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { BottomRoom } from '@/ui/bottom-room';

const block = () => document.querySelector<HTMLElement>('[data-aloud-room]');

describe('room at the end of the page for the reading bar', () => {
  it('is an empty block as tall as the bar covers, last in the page, gone with the bar', () => {
    document.body.innerHTML = '<article><p>The last line of the article.</p></article>';
    const room = new BottomRoom(document);
    room.setContent(document.querySelector('article'));
    room.setHeight(96.4);
    expect(block()?.style.height).toBe('97px');
    expect(document.body.lastElementChild).toBe(block());
    expect(block()?.textContent).toBe('');
    expect(block()?.getAttribute('aria-hidden')).toBe('true');
    room.setHeight(120);
    expect(document.querySelectorAll('[data-aloud-room]')).toHaveLength(1);
    expect(block()?.style.height).toBe('120px');
    room.remove();
    expect(block()).toBeNull();
  });

  it('stays last when the page adds something after it, and takes no room before the bar is measured', () => {
    document.body.innerHTML = '<main>text</main>';
    const room = new BottomRoom(document);
    room.setContent(document.querySelector('main'));
    expect(block()).toBeNull();
    room.setHeight(80);
    document.body.append(document.createElement('footer'));
    room.setHeight(90);
    expect(document.body.lastElementChild).toBe(block());
  });
});
