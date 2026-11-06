import { describe, expect, it } from 'vitest';
import { articleFrame, framePattern, frameSite, sameFrame } from '@/shared/frame-article';

const claude = 'https://9c6fc9bc-6fa6-45c6-865a-3809ae731c25.frame.claudeusercontent.com/_f/1793694717-bff4/?__frame_v=manifest.947411d6';

describe('the article is in a frame', () => {
  it('finds the frame a wrapper page is for: a Claude artifact covers 95% of the window', () => {
    const frames = [
      { src: claude, width: 1280, height: 855, visible: true },
      { src: '', width: 0, height: 0, visible: false },
    ];
    expect(articleFrame(frames, 1280, 900)?.src).toBe(claude);
  });

  it('not an ad, a player or a widget: under a third of the window, hidden, or not a web page', () => {
    expect(articleFrame([{ src: 'https://ads.example/x', width: 300, height: 250, visible: true }], 1280, 900)).toBeNull();
    expect(articleFrame([{ src: 'https://www.youtube.com/embed/x', width: 640, height: 360, visible: true }], 1280, 900)).toBeNull();
    expect(articleFrame([{ src: claude, width: 1280, height: 855, visible: false }], 1280, 900)).toBeNull();
    expect(articleFrame([{ src: 'about:blank', width: 1280, height: 855, visible: true }], 1280, 900)).toBeNull();
    expect(articleFrame([{ src: 'javascript:void 0', width: 1280, height: 855, visible: true }], 1280, 900)).toBeNull();
  });

  it('the largest when there are two', () => {
    const big = { src: 'https://docs.example/a', width: 1200, height: 700, visible: true };
    const small = { src: 'https://docs.example/b', width: 900, height: 500, visible: true };
    expect(articleFrame([small, big], 1280, 900)).toBe(big);
  });

  it('asks for a site once, even when every document has its own random address', () => {
    expect(framePattern(claude)).toBe('https://*.frame.claudeusercontent.com/*');
    expect(frameSite(claude)).toBe('frame.claudeusercontent.com');
    // An ordinary site is asked for as itself.
    expect(framePattern('https://reports.example.com/x?y')).toBe('https://reports.example.com/*');
    expect(framePattern('https://www.example.com/')).toBe('https://www.example.com/*');
    expect(frameSite('http://localhost:8776/frame.html')).toBe('localhost');
    // Nothing for what is not a web page.
    expect(framePattern('about:blank')).toBeNull();
    expect(framePattern('data:text/html,hi')).toBeNull();
  });

  it('knows the frame again after its address gains a fragment or a query', () => {
    expect(sameFrame(`${claude}#section`, claude)).toBe(true);
    expect(sameFrame('https://a.example/doc?x=2', 'https://a.example/doc?x=1')).toBe(true);
    expect(sameFrame('https://a.example/other', 'https://a.example/doc')).toBe(false);
    expect(sameFrame('https://b.example/doc', 'https://a.example/doc')).toBe(false);
  });
});
