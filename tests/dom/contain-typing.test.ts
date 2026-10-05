// @vitest-environment happy-dom
/** The independent review's item 14: typing into Aloud's note editor reached the page's keys. */
import { expect, it } from 'vitest';
import { containTyping } from '@/ui/contain-typing';

it('a key typed into an Aloud field does not reach the page; one on Aloud’s buttons still does', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<textarea></textarea><button>b</button>';
  containTyping(root);
  const seen: string[] = [];
  document.addEventListener('keydown', (e) => seen.push((e as KeyboardEvent).key));
  const fire = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
  fire(root.querySelector('textarea')!, 'j');
  fire(root.querySelector('button')!, 'Escape');
  expect(seen).toEqual(['Escape']);
});
