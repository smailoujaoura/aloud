// @vitest-environment happy-dom
/**
 * The recheck's R05: a saved article fetched its SVG picture and its audio before "Load images",
 * though its ordinary image was held. Every element's loading attributes are held now.
 */
import { describe, expect, it } from 'vitest';
import { heldCount, releaseHeld, sanitised } from '@/library/article-sanitise';

const ARTICLE = `
  <p>Text <a href="https://site.test/more" ping="https://track.test/p">a link</a></p>
  <img src="https://site.test/a.png" srcset="https://site.test/a2.png 2x">
  <svg><image href="https://site.test/svg.png"></image><use xlink:href="https://site.test/s.svg#i"></use></svg>
  <audio src="https://site.test/audio.mp3" autoplay></audio>
  <video src="//site.test/v.mp4" poster="https://site.test/p.jpg"><source src="https://site.test/v.webm"></video>
  <table background="https://site.test/bg.png"><tr><td>cell</td></tr></table>
  <img src="relative.png">
  <base href="https://site.test/">`;

/** Every attribute value under `root` that would make the browser contact site.test. */
function outsideLoads(root: ParentNode): string[] {
  const found: string[] = [];
  for (const node of root.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (attr.name.startsWith('data-aloud-held')) continue;
      const isNav = (node.localName === 'a' || node.localName === 'area') && attr.name === 'href';
      if (!isNav && /(?:https?:)?\/\/(site|track)\.test/.test(attr.value)) found.push(`${node.localName}[${attr.name}]`);
    }
  }
  return found;
}

describe('a saved article, before "Load images"', () => {
  it('asks nothing of the original site — not even for SVG pictures, audio, video or backgrounds', () => {
    const doc = document.createElement('div');
    doc.append(sanitised(ARTICLE));
    expect(outsideLoads(doc)).toEqual([]);
    expect(doc.querySelector('base')).toBeNull();
    expect(doc.querySelector('a')!.hasAttribute('ping')).toBe(false);
    expect(doc.querySelector('audio')!.hasAttribute('autoplay')).toBe(false);
    expect(doc.querySelector('img[src="relative.png"]')).not.toBeNull(); // Aloud's own address: left alone
    expect(heldCount(doc)).toBe(7); // img, image, use, audio, video, source, table
  });

  it('keeps links working: following one is the reader’s own act', () => {
    const doc = document.createElement('div');
    doc.append(sanitised(ARTICLE));
    const a = doc.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://site.test/more');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('"Load images" puts every address back where it was', () => {
    const doc = document.createElement('div');
    doc.append(sanitised(ARTICLE));
    releaseHeld(doc);
    expect(heldCount(doc)).toBe(0);
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('https://site.test/a.png');
    expect(doc.querySelector('image')!.getAttribute('href')).toBe('https://site.test/svg.png');
    expect(doc.querySelector('use')!.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('https://site.test/s.svg#i');
    expect(doc.querySelector('audio')!.getAttribute('src')).toBe('https://site.test/audio.mp3');
    expect(doc.querySelector('source')!.getAttribute('src')).toBe('https://site.test/v.webm');
    expect(doc.querySelector('table')!.getAttribute('background')).toBe('https://site.test/bg.png');
  });
});
