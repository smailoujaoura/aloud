// @vitest-environment happy-dom
/**
 * The independent review's item 6: when Aloud's reader ended, it cleared the page's own media
 * session — handlers and "now playing" — which a page cannot get back without a reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaControls } from '@/content/media-session';

function fakeSession(initial: { metadata?: unknown; playbackState?: string } = {}) {
  const handlers = new Map<string, unknown>();
  return {
    metadata: (initial.metadata ?? null) as unknown,
    playbackState: initial.playbackState ?? 'none',
    handlers,
    setActionHandler(action: string, fn: unknown) {
      if (fn) handlers.set(action, fn);
      else handlers.delete(action);
    },
  };
}
const noop = { play() {}, pause() {}, previous() {}, next() {} };

afterEach(() => vi.unstubAllGlobals());

describe('the page’s media session', () => {
  it('is left alone when the page is already using it', () => {
    const pageHandler = () => {};
    const session = fakeSession({ metadata: { title: 'Song on the page' }, playbackState: 'paused' });
    session.setActionHandler('play', pageHandler);
    vi.stubGlobal('navigator', { mediaSession: session });
    const controls = new MediaControls(noop);
    controls.setMetadata('Article', 'Alba', 'site.test');
    controls.dispose();
    expect(session.metadata).toEqual({ title: 'Song on the page' });
    expect(session.playbackState).toBe('paused');
    expect(session.handlers.get('play')).toBe(pageHandler);
  });

  it('is taken when unused, and left as it was found afterwards', () => {
    const session = fakeSession();
    vi.stubGlobal('navigator', { mediaSession: session });
    vi.stubGlobal('MediaMetadata', class { constructor(public init: unknown) {} });
    const controls = new MediaControls(noop);
    expect(session.handlers.has('play')).toBe(true);
    controls.setMetadata('Article', 'Alba', 'site.test');
    expect(session.metadata).not.toBeNull();
    controls.dispose();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    expect(session.handlers.size).toBe(0);
  });
});
